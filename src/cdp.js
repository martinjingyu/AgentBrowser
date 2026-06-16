import { setTimeout as delay } from "node:timers/promises";

export async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function discoverBrowserWs(port) {
  const version = await getJson(`http://127.0.0.1:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome did not expose webSocketDebuggerUrl");
  }
  return version.webSocketDebuggerUrl;
}

export async function discoverPageWs(port) {
  const pages = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = pages.find((t) => {
    return t.type === "page" && t.webSocketDebuggerUrl && !String(t.url).startsWith("devtools://");
  });
  if (!page) {
    throw new Error("Chrome did not expose a page target");
  }
  return page.webSocketDebuggerUrl;
}

export class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  // Decode WebSocket message data to a string synchronously.
  // In Node.js, WebSocket messages are strings or ArrayBuffers — never Blobs.
  // Keeping this synchronous eliminates microtask gaps between message arrival
  // and event dispatch, which previously caused waitForEvent to miss events.
  _decode(data) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    return String(data);
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket timeout")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket failed: ${this.wsUrl}`));
      }, { once: true });
    });

    // Synchronous handler: no await, so events land in this.events immediately.
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(this._decode(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message || "CDP error"}`));
        else resolve(msg.result ?? null);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }

  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      await delay(50);
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method };
    if (params && Object.keys(params).length > 0) payload.params = params;
    if (sessionId) payload.sessionId = sessionId;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  waitForEvent(method, sessionId, timeoutMs = 15000) {
    const found = this.events.find((e) => {
      return e.method === method && (!sessionId || e.sessionId === sessionId);
    });
    if (found) return Promise.resolve(found);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.removeEventListener("message", listener);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      // Synchronous listener — same reason as the connect() handler above.
      const listener = (event) => {
        const msg = JSON.parse(this._decode(event.data));
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer);
          this.ws.removeEventListener("message", listener);
          resolve(msg);
        }
      };
      this.ws.addEventListener("message", listener);
    });
  }
}

async function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

export async function connectPage(port) {
  const pageWs = await discoverPageWs(port);
  const cdp = new CdpConnection(pageWs);
  await cdp.connect();

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");
  await cdp.send("Network.enable");

  return { cdp, sessionId: undefined, targetId: undefined };
}

export async function connectBrowser(port) {
  const wsUrl = await discoverBrowserWs(port);
  const cdp = new CdpConnection(wsUrl);
  await cdp.connect();
  return cdp;
}

// Load signals, fastest to slowest:
//   frameNavigated      — main frame HTML received (~1-3s)
//   domContentEventFired — DOM parsed, before external resources
//   loadEventFired      — all resources done; skipped entirely by SPAs
const _LOAD_SIGNALS = new Set([
  "Page.frameNavigated",
  "Page.domContentEventFired",
  "Page.loadEventFired",
]);

export function waitForLoad(cdp, sessionId, timeoutMs = 10000) {
  // Check buffer first — the signal may have already arrived.
  const found = cdp.events.find(
    (e) => _LOAD_SIGNALS.has(e.method) && (!sessionId || e.sessionId === sessionId)
  );
  if (found) return Promise.resolve();

  // Single listener + single timer so there are no dangling promises/timers
  // after the first signal fires (Promise.race leaves orphaned timers that keep
  // the Node.js process alive for their full duration).
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cdp.ws.removeEventListener("message", listener);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);

    const listener = (event) => {
      if (settled) return;
      const msg = JSON.parse(cdp._decode(event.data));
      if (_LOAD_SIGNALS.has(msg.method) && (!sessionId || msg.sessionId === sessionId)) {
        finish();
      }
    };

    cdp.ws.addEventListener("message", listener);
  });
}
