#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connectPage, discoverBrowserWs, waitForLoad } from "./cdp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPort = process.env.AGENT_BROWSER_PORT ? Number(process.env.AGENT_BROWSER_PORT) : null;
const defaultPort = envPort ?? 9222;
const stateDir = process.env.AGENT_BROWSER_STATE_DIR || join(root, ".agentbrowser");
const profilesDir = process.env.AGENT_BROWSER_PROFILES_DIR || join(stateDir, "profiles");
const statePath = join(stateDir, "session.json");
const refsPath = join(stateDir, "refs.json");

function hasFlag(args, flag) {
  return args.includes(flag);
}

function ensureStateDir() {
  mkdirSync(stateDir, { recursive: true });
}

function readState() {
  if (!existsSync(statePath)) return { port: defaultPort };
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (envPort !== null) state.port = envPort;
  return state;
}

function writeState(state) {
  const toWrite = { ...state };
  if (envPort !== null) delete toWrite.port;  // don't persist env-overridden port
  ensureStateDir();
  writeFileSync(statePath, JSON.stringify(toWrite, null, 2));
}

function updateState(patch) {
  writeState({ ...readState(), ...patch });
}

function chromeCandidates() {
  const local = process.env.LOCALAPPDATA;
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    local && join(local, "Google\\Chrome\\Application\\chrome.exe"),
    local && join(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe")
  ].filter(Boolean);
}

function findChrome() {
  const found = chromeCandidates().find((p) => existsSync(p));
  if (!found) {
    throw new Error("Chrome not found. Set CHROME_PATH to chrome.exe.");
  }
  return found;
}

function startChrome(chrome, args) {
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", '""', chrome, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return;
  }

  const child = spawn(chrome, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function isPortReady(port) {
  try {
    await discoverBrowserWs(port);
    return true;
  } catch {
    return false;
  }
}

async function ensureChrome(port = defaultPort, options = {}) {
  if (await isPortReady(port)) {
    writeState({ port, headless: Boolean(options.headless) });
    return;
  }

  const mode = options.headless ? "headless" : "visible";
  const profileEnv = process.env.AGENT_BROWSER_PROFILE;
  const profileDir = profileEnv
    ? join(profilesDir, profileEnv)
    : join(stateDir, `chrome-profile-${port}-${mode}`);
  ensureStateDir();
  mkdirSync(profileDir, { recursive: true });

  const chrome = findChrome();
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(options.headless ? ["--headless=new", "--disable-gpu", "--window-size=1280,720"] : []),
    "about:blank"
  ];
  startChrome(chrome, chromeArgs);

  for (let i = 0; i < 80; i++) {
    if (await isPortReady(port)) {
      writeState({ port, profileDir, headless: Boolean(options.headless) });
      return;
    }
    await delay(250);
  }
  throw new Error(`Chrome started but CDP was not ready on port ${port}`);
}

async function withPage(fn) {
  const state = readState();
  await ensureChrome(state.port ?? defaultPort, { headless: state.headless });
  const { cdp, sessionId } = await connectPage(state.port ?? defaultPort);
  try {
    return await fn(cdp, sessionId);
  } finally {
    await cdp.close();
  }
}

function normalizeUrl(raw) {
  if (/^(https?|about|data|file|chrome):/i.test(raw)) return raw;
  return `https://${raw}`;
}

function jsString(value) {
  return JSON.stringify(value);
}

async function runtimeEval(cdp, sessionId, expression, returnByValue = true) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return res.result?.value;
}

async function cmdOpen(args) {
  if (hasFlag(args, "--headless")) updateState({ headless: true });
  if (hasFlag(args, "--visible")) updateState({ headless: false });
  const firstValue = args.find((arg) => !arg.startsWith("--"));
  const url = normalizeUrl(firstValue ?? "about:blank");
  await withPage(async (cdp, sessionId) => {
    await cdp.send("Page.navigate", { url }, sessionId);
    await waitForLoad(cdp, sessionId);
    console.log(`opened ${url}`);
  });
}

async function cmdSnapshot(args = []) {
  await withPage(async (cdp, sessionId) => {
    const expression = `(() => {
      const roleFor = (el) => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.localName;
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "input") {
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (type === "search") return "searchbox";
          if (type === "submit" || type === "button" || type === "reset") return "button";
          return "textbox";
        }
        if (el.isContentEditable) return "textbox";
        return "button";
      };
      const isVisible = (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
      };
      const selectorFor = (el) => {
        if (el.id) return "#" + CSS.escape(el.id);
        const parts = [];
        while (el && el.nodeType === 1 && parts.length < 5) {
          let part = el.localName;
          if (el.classList && el.classList.length) {
            part += "." + [...el.classList].slice(0, 2).map(CSS.escape).join(".");
          }
          const parent = el.parentElement;
          if (parent) {
            const same = [...parent.children].filter((x) => x.localName === el.localName);
            if (same.length > 1) part += \`:nth-of-type(\${same.indexOf(el) + 1})\`;
          }
          parts.unshift(part);
          el = parent;
        }
        return parts.join(" > ");
      };
      const nodes = [...document.querySelectorAll("a[href],button,input,textarea,select,[role=button],[onclick],[contenteditable=true]")];
      return nodes
        .filter(isVisible)
        .sort((a, b) => {
          const aIsLink = a.localName === "a" || a.getAttribute("role") === "link";
          const bIsLink = b.localName === "a" || b.getAttribute("role") === "link";
          return Number(bIsLink) - Number(aIsLink);
        })
        .slice(0, 120)
        .map((el, i) => {
        const r = el.getBoundingClientRect();
        const href = el.href || "";
        const label = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || href || "").replace(/\\s+/g, " ").trim();
        const role = roleFor(el);
        const ref = "e" + (i + 1);
        return {
          ref,
          role,
          name: label.slice(0, 120),
          tag: el.localName,
          type: el.getAttribute("type") || el.getAttribute("role") || "",
          text: label.slice(0, 120),
          url: href,
          selector: selectorFor(el),
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2)
        };
      });
    })()`;

    const items = await runtimeEval(cdp, sessionId, expression);
    ensureStateDir();
    const refs = Object.fromEntries(items.map((item) => {
      const entry = {
        role: item.role,
        name: item.name,
        selector: item.selector,
        x: item.x,
        y: item.y
      };
      if (item.url) entry.url = item.url;
      return [item.ref, entry];
    }));
    writeFileSync(refsPath, JSON.stringify(refs, null, 2));

    const snapshot = items.length
      ? items.map((item) => {
          const name = item.name ? ` ${JSON.stringify(item.name)}` : "";
          const attrs = [`ref=${item.ref}`];
          if (item.url) attrs.push(`url=${item.url}`);
          return `- ${item.role}${name} [${attrs.join(", ")}]`;
        }).join("\n")
      : "(no interactive elements)";

    if (args.includes("--json")) {
      const origin = await runtimeEval(cdp, sessionId, "location.href");
      console.log(JSON.stringify({ snapshot, origin, refs }, null, 2));
      return;
    }

    console.log(snapshot);
    /*
    for (const item of items) {
      const desc = [item.ref, item.tag, item.type, item.text].filter(Boolean).join(" ");
      console.log(`${desc} (${item.x},${item.y}) ${item.selector}`);
    }
    if (!items.length) console.log("no interactive elements found");
    */
  });
}

function readRefs() {
  if (!existsSync(refsPath)) {
    throw new Error("No refs saved. Run `node src/cli.js snapshot` first.");
  }
  const refs = JSON.parse(readFileSync(refsPath, "utf8"));
  if (Array.isArray(refs)) return refs;
  return Object.entries(refs).map(([ref, entry]) => ({ ref, ...entry }));
}

async function cmdClick(args) {
  const target = args[0];
  if (!target) throw new Error("Usage: click <@ref|css-selector|x,y>");

  await withPage(async (cdp, sessionId) => {
    if (/^@\w+/.test(target)) {
      const id = target.slice(1);
      const ref = readRefs().find((r) => r.ref === id || r.ref === target);
      if (!ref) throw new Error(`Unknown ref ${target}. Run snapshot again.`);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: ref.x, y: ref.y, button: "left", clickCount: 1
      }, sessionId);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: ref.x, y: ref.y, button: "left", clickCount: 1
      }, sessionId);
      console.log(`clicked ${target}`);
      return;
    }

    const xy = target.match(/^(\d+),(\d+)$/);
    if (xy) {
      const x = Number(xy[1]);
      const y = Number(xy[2]);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
      console.log(`clicked ${x},${y}`);
      return;
    }

    await runtimeEval(cdp, sessionId, `(() => {
      const el = document.querySelector(${jsString(target)});
      if (!el) throw new Error("selector not found: " + ${jsString(target)});
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return true;
    })()`);
    console.log(`clicked ${target}`);
  });
}

async function cmdScreenshot(args) {
  const out = resolve(args[0] ?? join(stateDir, `screenshot-${Date.now()}.png`));
  await withPage(async (cdp, sessionId) => {
    const res = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true
    }, sessionId);
    writeFileSync(out, Buffer.from(res.data, "base64"));
    console.log(out);
  });
}

async function cmdScroll(args) {
  let amount;
  const direction = args[0]?.toLowerCase();
  if (direction === "up" || direction === "down") {
    const pixels = Number(args[1] ?? 600);
    if (!Number.isFinite(pixels)) {
      throw new Error("Usage: scroll up [pixels] | scroll down [pixels]");
    }
    amount = direction === "up" ? -Math.abs(pixels) : Math.abs(pixels);
  } else {
    amount = Number(args[0] ?? 600);
    if (!Number.isFinite(amount)) {
      throw new Error("Usage: scroll [pixels] | scroll up [pixels] | scroll down [pixels]");
    }
  }

  await withPage(async (cdp, sessionId) => {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 500,
      y: 500,
      deltaX: 0,
      deltaY: amount
    }, sessionId);
    console.log(amount < 0 ? `scrolled up ${Math.abs(amount)}` : `scrolled down ${amount}`);
  });
}

async function cmdKeyboard(args) {
  const sub = args[0];
  if (sub === "type") {
    const text = args.slice(1).join(" ");
    if (!text) throw new Error("Usage: keyboard type <text>");
    await withPage(async (cdp, sessionId) => {
      await cdp.send("Input.insertText", { text }, sessionId);
      console.log(`typed ${text.length} chars`);
    });
    return;
  }

  if (sub === "press") {
    const key = args[1];
    if (!key) throw new Error("Usage: keyboard press <Enter|Tab|Escape|...>");
    await withPage(async (cdp, sessionId) => {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key }, sessionId);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key }, sessionId);
      console.log(`pressed ${key}`);
    });
    return;
  }

  throw new Error("Usage: keyboard type <text> | keyboard press <key>");
}

async function cmdClose() {
  const state = readState();
  const port = state.port ?? defaultPort;
  try {
    const { cdp } = await connectPage(port);
    try { await cdp.send("Browser.close"); } catch { /* ignore */ }
    await cdp.close();
    console.log(JSON.stringify({ success: true, closed: true }));
  } catch {
    console.log(JSON.stringify({ success: true, closed: false, note: "not running" }));
  }
}

async function cmdBack() {
  await withPage(async (cdp, sessionId) => {
    await cdp.send("Page.goBack", {}, sessionId);
    await waitForLoad(cdp, sessionId);
    console.log(JSON.stringify({ success: true }));
  });
}

function usage() {
  console.log(`agentBrowser minimal CDP controller

Commands:
  node src/cli.js start [port] [--headless]  launch Chrome
  node src/cli.js open <url>                  navigate current tab
  node src/cli.js snapshot                    list interactive elements as @e refs
  node src/cli.js click <@ref|selector|x,y>   click element
  node src/cli.js screenshot [path]           save PNG screenshot
  node src/cli.js scroll [pixels]             scroll by signed pixels
  node src/cli.js scroll down [pixels]        scroll down
  node src/cli.js scroll up [pixels]          scroll up
  node src/cli.js keyboard type <text>        type text
  node src/cli.js keyboard press <key>        press key
  node src/cli.js back                        navigate back in history
  node src/cli.js close                       close Chrome

Environment:
  AGENT_BROWSER_PORT          override CDP port (default: 9222)
  AGENT_BROWSER_STATE_DIR     override state dir (session.json, refs.json)
  AGENT_BROWSER_PROFILES_DIR  base directory for managed profiles
  AGENT_BROWSER_PROFILE       profile name within AGENT_BROWSER_PROFILES_DIR
  CHROME_PATH                 override Chrome executable path
`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return usage();

  if (cmd === "start") {
    const headless = hasFlag(args, "--headless");
    const portArg = args.find((arg) => !arg.startsWith("--"));
    const port = Number(portArg ?? defaultPort);
    await ensureChrome(port, { headless });
    console.log(`${headless ? "headless" : "visible"} Chrome ready on CDP port ${port}`);
    return;
  }
  if (cmd === "open") return cmdOpen(args);
  if (cmd === "snapshot") return cmdSnapshot(args);
  if (cmd === "click") return cmdClick(args);
  if (cmd === "screenshot") return cmdScreenshot(args);
  if (cmd === "scroll") return cmdScroll(args);
  if (cmd === "keyboard") return cmdKeyboard(args);
  if (cmd === "close") return cmdClose();
  if (cmd === "back") return cmdBack();

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
