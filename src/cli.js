#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connectPage, connectBrowser, discoverBrowserWs, waitForLoad } from "./cdp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPort = process.env.AGENT_BROWSER_PORT ? Number(process.env.AGENT_BROWSER_PORT) : null;
const defaultPort = envPort ?? 9222;

// Per-target session ID — when set, all commands route to this specific Chrome target
const targetId = process.env.AGENT_BROWSER_TARGET_ID || null;

// Global state dir: holds session.json (which Chrome port/headless mode)
const globalStateDir = process.env.AGENT_BROWSER_STATE_DIR || join(homedir(), ".agentbrowser");
const statePath = join(globalStateDir, "session.json");

// Per-target state dir: holds refs.json (element refs for a specific session)
const targetStateDir = targetId
  ? join(homedir(), ".agentbrowser", "targets", targetId)
  : globalStateDir;
const refsPath = join(targetStateDir, "refs.json");

const profilesDir = process.env.AGENT_BROWSER_PROFILES_DIR || join(globalStateDir, "profiles");

function hasFlag(args, flag) {
  return args.includes(flag);
}

function ensureGlobalStateDir() {
  mkdirSync(globalStateDir, { recursive: true });
}

function ensureTargetStateDir() {
  mkdirSync(targetStateDir, { recursive: true });
}

function readState() {
  if (!existsSync(statePath)) return { port: defaultPort };
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (envPort !== null) state.port = envPort;
  return state;
}

function writeState(state) {
  const toWrite = { ...state };
  if (envPort !== null) delete toWrite.port;
  ensureGlobalStateDir();
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
    : join(globalStateDir, `chrome-profile-${port}-${mode}`);
  ensureGlobalStateDir();
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

// Connect to a specific target (session) via the browser-level WebSocket.
// Each CLI invocation attaches fresh — sessionId is connection-scoped, not persistent.
async function attachTarget(cdp, tId) {
  const result = await cdp.send("Target.attachToTarget", { targetId: tId, flatten: true });
  const sessionId = result.sessionId;
  // Enable required CDP domains for this session
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("DOM.enable", {}, sessionId);
  await cdp.send("Accessibility.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  return sessionId;
}

async function withPage(fn) {
  const state = readState();
  const port = state.port ?? defaultPort;
  await ensureChrome(port, { headless: state.headless });

  if (targetId) {
    const cdp = await connectBrowser(port);
    try {
      const sessionId = await attachTarget(cdp, targetId);
      return await fn(cdp, sessionId);
    } finally {
      await cdp.close();
    }
  } else {
    const { cdp, sessionId } = await connectPage(port);
    try {
      return await fn(cdp, sessionId);
    } finally {
      await cdp.close();
    }
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
    ensureTargetStateDir();
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
  const out = resolve(args[0] ?? join(targetStateDir, `screenshot-${Date.now()}.png`));
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

async function cmdBack() {
  await withPage(async (cdp, sessionId) => {
    await cdp.send("Page.goBack", {}, sessionId);
    await waitForLoad(cdp, sessionId);
    console.log(JSON.stringify({ success: true }));
  });
}

// Create a new browser tab (target). With --isolated, creates a separate BrowserContext
// so this session gets its own cookie jar. Without it, shares cookies with all other sessions.
async function cmdCreateSession(args) {
  const isolated = hasFlag(args, "--isolated");
  const state = readState();
  const port = state.port ?? defaultPort;
  await ensureChrome(port, { headless: state.headless });

  const cdp = await connectBrowser(port);
  try {
    let browserContextId;
    if (isolated) {
      const ctx = await cdp.send("Target.createBrowserContext", {});
      browserContextId = ctx.browserContextId;
    }

    const params = { url: "about:blank" };
    if (browserContextId) params.browserContextId = browserContextId;
    const target = await cdp.send("Target.createTarget", params);

    console.log(JSON.stringify({
      success: true,
      targetId: target.targetId,
      browserContextId: browserContextId ?? null,
    }));
  } finally {
    await cdp.close();
  }
}

// Close the current session's target (and its BrowserContext if isolated).
// Does NOT close the whole Chrome browser.
async function cmdCloseSession(args) {
  const tId = targetId || args[0];
  if (!tId) throw new Error("No targetId: set AGENT_BROWSER_TARGET_ID or pass as argument");

  const port = readState().port ?? defaultPort;
  try {
    const cdp = await connectBrowser(port);
    try {
      const { targetInfos } = await cdp.send("Target.getTargets", {});
      const info = targetInfos?.find((t) => t.targetId === tId);

      await cdp.send("Target.closeTarget", { targetId: tId });

      // Dispose isolated BrowserContext (non-empty browserContextId = not the default context)
      if (info?.browserContextId) {
        try {
          await cdp.send("Target.disposeBrowserContext", {
            browserContextId: info.browserContextId,
          });
        } catch { /* default context cannot be disposed — ignore */ }
      }

      console.log(JSON.stringify({ success: true }));
    } finally {
      await cdp.close();
    }
  } catch {
    console.log(JSON.stringify({ success: true, note: "browser not running" }));
  }
}

// ---------------------------------------------------------------------------
// Search result extractors
// These are defined as real JS functions so .toString() serializes them
// cleanly into a IIFE for runtimeEval — no string-escaping issues.
// ---------------------------------------------------------------------------

function googleResultExtractor() {
  const seen = new Set();
  const results = [];
  for (const h3 of document.querySelectorAll('h3')) {
    const a = h3.closest('a[href]');
    if (!a) continue;
    let url = a.href;
    try {
      const u = new URL(url);
      // Unwrap Google's redirect wrapper (/url?q=...)
      if (u.pathname === '/url') url = u.searchParams.get('q') || url;
      if (u.hostname.includes('google.')) continue;
    } catch { continue; }
    if (!url || seen.has(url) || url.startsWith('#')) continue;
    seen.add(url);
    const title = h3.innerText.trim();
    if (!title) continue;
    // Walk up from the link to find descriptive snippet text in nearby spans
    let snippet = '';
    let el = a.parentElement;
    for (let i = 0; i < 6 && el && !snippet; i++, el = el.parentElement) {
      for (const s of el.querySelectorAll('span, em')) {
        const t = (s.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > 60 && t.slice(0, 15) !== title.slice(0, 15)) {
          snippet = t.slice(0, 280);
          break;
        }
      }
    }
    results.push({ title, url, snippet });
  }
  return results;
}

function bingResultExtractor() {
  const results = [];
  for (const li of document.querySelectorAll('li.b_algo')) {
    const a = li.querySelector('h2 a');
    if (!a || !a.href) continue;
    const title = a.innerText.trim();
    const snippetEl = li.querySelector('.b_caption p, p.b_lineclamp3, p.b_lineclamp4, .b_algoSlug');
    const snippet = (snippetEl?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    results.push({ title, url: a.href, snippet });
  }
  return results;
}

function baiduResultExtractor() {
  const results = [];
  for (const item of document.querySelectorAll('.result, .c-container')) {
    const a = item.querySelector('h3 a, .t a');
    if (!a || !a.href) continue;
    const title = a.innerText.trim();
    const snippetEl = item.querySelector('.c-abstract, .content-right_8Zs40');
    const snippet = (snippetEl?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    results.push({ title, url: a.href, snippet });
  }
  return results;
}

async function waitForSelector(cdp, sessionId, selector, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await runtimeEval(cdp, sessionId, `!!document.querySelector(${JSON.stringify(selector)})`);
    if (found) return true;
    await delay(250);
  }
  return false;
}

async function cmdSearchResults() {
  await withPage(async (cdp, sessionId) => {
    const origin = await runtimeEval(cdp, sessionId, 'location.href');

    let extractor = googleResultExtractor;
    let waitSelector = 'h3';
    if (typeof origin === 'string') {
      if (origin.includes('bing.com')) { extractor = bingResultExtractor; waitSelector = 'li.b_algo'; }
      else if (origin.includes('baidu.com')) { extractor = baiduResultExtractor; waitSelector = '.result'; }
    }

    await waitForSelector(cdp, sessionId, waitSelector, 5000);

    const results = await runtimeEval(cdp, sessionId, `(${extractor.toString()})()`);
    console.log(JSON.stringify({ success: true, results: results ?? [], origin }));
  });
}

// Close the entire Chrome browser process via CDP.
async function cmdClose() {
  const port = readState().port ?? defaultPort;
  try {
    const cdp = await connectBrowser(port);
    try { await cdp.send("Browser.close"); } catch { /* ignore */ }
    await cdp.close();
    console.log(JSON.stringify({ success: true, closed: true }));
  } catch {
    console.log(JSON.stringify({ success: true, closed: false, note: "not running" }));
  }
}

function usage() {
  console.log(`agentBrowser minimal CDP controller

Commands:
  node src/cli.js start [port] [--headless]    launch Chrome
  node src/cli.js create-session [--isolated]  create a new browser tab; returns targetId
  node src/cli.js close-session [targetId]     close a session tab (not the whole browser)
  node src/cli.js open <url>                   navigate current tab
  node src/cli.js snapshot                     list interactive elements as @e refs
  node src/cli.js click <@ref|selector|x,y>    click element
  node src/cli.js screenshot [path]            save PNG screenshot
  node src/cli.js scroll [pixels]              scroll by signed pixels
  node src/cli.js scroll down [pixels]         scroll down
  node src/cli.js scroll up [pixels]           scroll up
  node src/cli.js keyboard type <text>         type text
  node src/cli.js keyboard press <key>         press key
  node src/cli.js back                         navigate back in history
  node src/cli.js close                        close entire Chrome browser

Environment:
  AGENT_BROWSER_PORT          override CDP port (default: 9222)
  AGENT_BROWSER_TARGET_ID     route all commands to this Chrome target (tab)
  AGENT_BROWSER_STATE_DIR     override global state dir (session.json)
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
  if (cmd === "create-session") return cmdCreateSession(args);
  if (cmd === "close-session") return cmdCloseSession(args);
  if (cmd === "search-results") return cmdSearchResults();
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
