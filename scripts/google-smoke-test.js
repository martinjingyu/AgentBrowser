#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connectPage, discoverBrowserWs, waitForLoad } from "../src/cdp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = join(root, ".agentbrowser");
const outDir = join(stateDir, "smoke-tests");
const defaultPort = 9222;

const args = parseArgs(process.argv.slice(2));
const count = Number(args.count ?? 100);
const delayMs = Number(args.delayMs ?? 5000);
const port = Number(args.port ?? defaultPort);
const headless = Boolean(args.headless);
const stopOnVerification = Boolean(args.stopOnVerification);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const jsonlPath = resolve(args.jsonl ?? join(outDir, `google-smoke-${runId}.jsonl`));
const csvPath = resolve(args.csv ?? join(outDir, `google-smoke-${runId}.csv`));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
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
  if (!found) throw new Error("Chrome not found. Set CHROME_PATH to chrome.exe.");
  return found;
}

function startChrome(chrome, chromeArgs) {
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", '""', chrome, ...chromeArgs], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return;
  }
  const child = spawn(chrome, chromeArgs, { detached: true, stdio: "ignore" });
  child.unref();
}

async function isPortReady(p) {
  try {
    await discoverBrowserWs(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureChrome(p) {
  mkdirSync(stateDir, { recursive: true });
  if (await isPortReady(p)) return;

  const mode = headless ? "headless" : "visible";
  const profileDir = join(stateDir, `google-smoke-profile-${p}-${mode}`);
  mkdirSync(profileDir, { recursive: true });
  startChrome(findChrome(), [
    `--remote-debugging-port=${p}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless=new", "--disable-gpu", "--window-size=1280,720"] : []),
    "about:blank"
  ]);

  for (let i = 0; i < 80; i++) {
    if (await isPortReady(p)) return;
    await delay(250);
  }
  throw new Error(`Chrome started but CDP was not ready on port ${p}`);
}

function keywordFor(index) {
  const topics = [
    "resume screening", "javascript websocket", "chrome devtools protocol",
    "python pdf extraction", "machine learning", "frontend testing",
    "recruiting automation", "browser automation", "accessibility tree",
    "nodejs file system", "typescript cli", "web performance",
    "data extraction", "open source project", "software engineering",
    "natural language processing", "pdf to image", "ocr pipeline",
    "candidate evaluation", "search engine indexing"
  ];
  const topic = topics[index % topics.length];
  return `${topic} smoke test ${index + 1} ${runId.slice(0, 10)}`;
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function pageState(cdp) {
  return evaluate(cdp, `(() => {
    const text = document.body ? document.body.innerText : "";
    const title = document.title || "";
    const url = location.href;
    const captchaLike = [
      "Our systems have detected unusual traffic",
      "unusual traffic from your computer network",
      "About this page",
      "Before you continue",
      "g-recaptcha",
      "recaptcha",
      "/sorry/"
    ];
    const haystack = (url + "\\n" + title + "\\n" + text + "\\n" + document.documentElement.outerHTML).toLowerCase();
    const matched = captchaLike.filter((p) => haystack.includes(p.toLowerCase()));
    const resultStats = document.querySelector("#result-stats")?.innerText || "";
    const searchBox = document.querySelector("textarea[name=q], input[name=q]")?.value || "";
    return {
      url,
      title,
      searchBox,
      resultStats,
      textSample: text.replace(/\\s+/g, " ").slice(0, 240),
      verification: matched.length > 0,
      verificationSignals: matched
    };
  })()`);
}

function csvCell(value) {
  const s = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

function writeRecord(record) {
  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
  appendFileSync(csvPath, [
    record.index,
    record.keyword,
    record.status,
    record.verification,
    record.url,
    record.title,
    record.verificationSignals,
    record.error || ""
  ].map(csvCell).join(",") + "\n");
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(csvPath, "index,keyword,status,verification,url,title,verificationSignals,error\n");
  writeFileSync(jsonlPath, "");

  await ensureChrome(port);
  const { cdp } = await connectPage(port);

  let verificationCount = 0;
  try {
    for (let i = 0; i < count; i++) {
      const keyword = keywordFor(i);
      const url = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&hl=en`;
      const startedAt = new Date().toISOString();
      let record;

      try {
        await cdp.send("Page.navigate", { url });
        await waitForLoad(cdp, undefined, 20000);
        await delay(1500);
        const state = await pageState(cdp);
        verificationCount += state.verification ? 1 : 0;
        record = {
          index: i + 1,
          keyword,
          status: "ok",
          startedAt,
          finishedAt: new Date().toISOString(),
          verification: state.verification,
          verificationSignals: state.verificationSignals,
          url: state.url,
          title: state.title,
          resultStats: state.resultStats,
          searchBox: state.searchBox,
          textSample: state.textSample
        };
      } catch (err) {
        record = {
          index: i + 1,
          keyword,
          status: "error",
          startedAt,
          finishedAt: new Date().toISOString(),
          verification: false,
          verificationSignals: [],
          url: "",
          title: "",
          error: err.message
        };
      }

      writeRecord(record);
      console.log(`${record.index}/${count} verification=${record.verification} status=${record.status} ${record.keyword}`);

      if (record.verification && stopOnVerification) break;
      if (i < count - 1) await delay(delayMs);
    }
  } finally {
    await cdp.close();
  }

  console.log(`done. verificationCount=${verificationCount}`);
  console.log(`jsonl: ${jsonlPath}`);
  console.log(`csv: ${csvPath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
