from __future__ import annotations

import atexit
import json
import os
import re
import subprocess
import time
from contextvars import ContextVar
from pathlib import Path

# ---------------------------------------------------------------------------
# CLI path resolution
# ---------------------------------------------------------------------------

def _find_cli() -> Path:
    candidates = [
        Path(__file__).parent.parent / "src" / "cli.js",  # dev: src/ takes priority when repo is present
        Path(__file__).parent / "data" / "cli.js",        # fallback for pip-installed packages
    ]
    for p in candidates:
        if p.exists():
            return p
    raise FileNotFoundError(
        "agentBrowser CLI not found. Expected at one of:\n"
        + "\n".join(f"  {p}" for p in candidates)
        + "\nRe-install the package or copy src/cli.js to agent_browser/data/cli.js."
    )


# ---------------------------------------------------------------------------
# Session management via ContextVar
#
# One Chrome instance runs on _BROWSER_PORT (shared across all agents).
# Each agent gets its own browser tab (CDP Target), identified by target_id.
# The ContextVar isolates sessions across asyncio Tasks and threads automatically:
#   - asyncio: each Task inherits a copy of the parent context at creation time
#   - threading: each thread inherits a copy of the spawning thread's context
# In both cases, setting a session inside a task/thread only affects that task/thread.
# ---------------------------------------------------------------------------

_BROWSER_PORT = int(os.getenv("AGENT_BROWSER_PORT", "9222"))

# {"target_id": str, "browser_context_id": str | None}
_current_session: ContextVar[dict | None] = ContextVar("browser_session", default=None)


def _kill_chrome_on_port(port: int) -> None:
    try:
        if os.name == "nt":
            r = subprocess.run(
                ["powershell", "-Command",
                 f"Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue"
                 f" | Select-Object -ExpandProperty OwningProcess"],
                capture_output=True, text=True, timeout=8, creationflags=0x08000000,
            )
            for line in r.stdout.splitlines():
                line = line.strip()
                if line.isdigit():
                    subprocess.run(
                        ["taskkill", "/F", "/PID", line],
                        capture_output=True, timeout=5, creationflags=0x08000000,
                    )
        else:
            subprocess.run(["fuser", "-k", f"{port}/tcp"], capture_output=True, timeout=5)
    except Exception:
        pass


def _atexit_cleanup() -> None:
    _kill_chrome_on_port(_BROWSER_PORT)


atexit.register(_atexit_cleanup)


# ---------------------------------------------------------------------------
# CLI runner
# ---------------------------------------------------------------------------

def _base_env() -> dict[str, str]:
    """Env vars needed for any CLI call (port + profile), without session routing."""
    from ._profile import ensure_browser_profile, _profiles_dir
    ensure_browser_profile()
    env = dict(os.environ)
    env["AGENT_BROWSER_PORT"] = str(_BROWSER_PORT)
    env["AGENT_BROWSER_PROFILES_DIR"] = str(_profiles_dir())
    return env


def _cli_env() -> dict[str, str]:
    """Build subprocess env for the calling context's browser session.

    Auto-creates a session on first use if none is bound to this context.
    """
    session = _current_session.get()
    if session is None:
        result = _run_raw("create-session", env=_base_env())
        if not result.get("success"):
            raise RuntimeError(f"Failed to create browser session: {result.get('error')}")
        session = {
            "target_id": result["targetId"],
            "browser_context_id": result.get("browserContextId"),
        }
        _current_session.set(session)

    env = _base_env()
    env["AGENT_BROWSER_TARGET_ID"] = session["target_id"]
    env["AGENT_BROWSER_STATE_DIR"] = str(
        Path.home() / ".agentbrowser" / "targets" / session["target_id"]
    )
    return env


def _run_raw(command: str, *args: str, env: dict, timeout: int = 60) -> dict:
    """Run agentBrowser CLI with a fully-specified env dict."""
    cli = _find_cli()
    cmd = ["node", str(cli), command, *args]
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, env=env, **kwargs,
        )
    except FileNotFoundError:
        return {"success": False, "error": "node not found in PATH"}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"timed out after {timeout}s"}

    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()

    if stdout:
        try:
            return {"success": True, **json.loads(stdout)}
        except json.JSONDecodeError:
            pass

    if proc.returncode != 0:
        return {"success": False, "error": stderr or f"exit code {proc.returncode}"}

    return {"success": True, "output": stdout}


def _run(command: str, *args: str, timeout: int = 60) -> dict:
    """Run agentBrowser CLI routed to the current context's session."""
    return _run_raw(command, *args, env=_cli_env(), timeout=timeout)


def _run_recovering(command: str, *args: str, timeout: int = 60) -> dict:
    """Run a CDP command; on session freeze close and recreate the session, then retry once."""
    result = _run(command, *args, timeout=timeout)
    if not result.get("success") and "CDP command timed out" in result.get("error", ""):
        print(f"[Browser] CDP timeout on '{command}', recreating session and retrying...")
        close_session()
        result = _run(command, *args, timeout=timeout)
    return result


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------

def create_session(isolated: bool = False) -> dict:
    """Explicitly create a new browser session for this context.

    isolated=True creates a separate BrowserContext (own cookie jar).
    Without it, the session shares cookies with all other sessions (same Chrome profile).
    Sessions are normally created automatically on first browser call — only call this
    if you need to control the lifecycle explicitly or want an isolated cookie jar.
    """
    args = ["--isolated"] if isolated else []
    result = _run_raw("create-session", *args, env=_base_env())
    if not result.get("success"):
        raise RuntimeError(f"Failed to create browser session: {result.get('error')}")
    session = {
        "target_id": result["targetId"],
        "browser_context_id": result.get("browserContextId"),
    }
    _current_session.set(session)
    return session


def close_session() -> dict:
    """Close this context's browser tab. Does not shut down the whole Chrome browser.

    After closing, the next browser call will auto-create a fresh session.
    """
    session = _current_session.get()
    if session is None:
        return {"success": True, "note": "no session to close"}
    result = _run_raw(
        "close-session", session["target_id"],
        env=_base_env(),
        timeout=15,
    )
    _current_session.set(None)
    return result


def close_browser() -> dict:
    """Shut down the entire Chrome browser process.

    Prefer close_session() to release just this agent's tab.
    Use this only when you want to fully terminate Chrome.
    """
    result = _run_raw("close", env=_base_env(), timeout=15)
    _current_session.set(None)
    _kill_chrome_on_port(_BROWSER_PORT)
    return result


# ---------------------------------------------------------------------------
# Public browser functions
# ---------------------------------------------------------------------------

_NAVIGATE_SNAPSHOT_LIMIT = 8000


_EMPTY_SNAPSHOT = frozenset({"", "(no interactive elements)"})
_RENDER_RETRY_DELAYS = (0.8, 1.5)  # seconds; only paid when page looks empty


def navigate(url: str) -> dict:
    """Navigate to URL and return a truncated snapshot of the loaded page."""
    result = _run_recovering("open", url, timeout=30)
    if not result.get("success"):
        return result
    snap = snapshot()
    # waitForLoad resolves on the earliest of frameNavigated / domContentEventFired /
    # loadEventFired, often before JS has rendered interactive elements.  If the
    # snapshot looks empty, wait briefly and retry — adds no overhead on fast pages.
    for delay in _RENDER_RETRY_DELAYS:
        if snap.get("snapshot", "").strip() not in _EMPTY_SNAPSHOT:
            break
        time.sleep(delay)
        snap = snapshot()
    text = snap.get("snapshot", "")
    truncated = len(text) > _NAVIGATE_SNAPSHOT_LIMIT
    if truncated:
        text = text[:_NAVIGATE_SNAPSHOT_LIMIT] + "\n\n[truncated — call snapshot() for full content]"
    return {
        "success": True,
        "url": url,
        "snapshot": text,
        "refs": snap.get("refs", {}),
        **({"truncated": True} if truncated else {}),
    }


def snapshot() -> dict:
    """Return accessibility snapshot with @ref IDs for all interactive elements."""
    result = _run_recovering("snapshot", "--json", timeout=60)
    if not result.get("success"):
        return result
    return {
        "success": True,
        "snapshot": result.get("snapshot", ""),
        "refs": result.get("refs", {}),
        "origin": result.get("origin", ""),
    }


def click(ref: str) -> dict:
    """Click an element by @ref from the last snapshot (e.g. 'e5' or '@e5')."""
    if ref and not ref.startswith("@"):
        ref = "@" + ref
    result = _run("click", ref, timeout=60)
    if not result.get("success"):
        return result
    return {"success": True, "clicked": ref}


def type_text(text: str) -> dict:
    """Type text into the currently focused element."""
    result = _run("keyboard", "type", text, timeout=60)
    if not result.get("success"):
        return result
    return {"success": True, "typed": len(text)}


def press_key(key: str) -> dict:
    """Press a keyboard key (e.g. 'Enter', 'Tab', 'Escape')."""
    result = _run("keyboard", "press", key, timeout=60)
    if not result.get("success"):
        return result
    return {"success": True, "key": key}


def scroll(direction: str = "down", pixels: int = 600) -> dict:
    """Scroll the page up or down by `pixels`."""
    result = _run("scroll", direction, str(pixels), timeout=60)
    if not result.get("success"):
        return result
    return {"success": True, "direction": direction, "pixels": pixels}


def back() -> dict:
    """Navigate back in browser history."""
    result = _run_recovering("back", timeout=30)
    if not result.get("success"):
        return result
    return {"success": True}


# ---------------------------------------------------------------------------
# Search helpers
# ---------------------------------------------------------------------------

_SITE_RE = re.compile(r'\bsite:([A-Za-z0-9-]+)(?:\.[A-Za-z0-9-]+)*(?:/\S*)?')


def _normalize_query(query: str) -> str:
    """Strip TLD and path from site: operators to reduce bot-detection risk.

    'pytorch tutorial site:github.com/pytorch' → 'pytorch tutorial site:github'
    """
    return _SITE_RE.sub("", query).strip()


def _search(url: str, query: str) -> dict:
    """Navigate to a search URL then extract structured results."""
    nav = _run_recovering("open", url, timeout=30)
    if not nav.get("success"):
        return nav
    result = _run("search-results", timeout=30)
    if not result.get("success"):
        return result
    return {
        "success": True,
        "query": query,
        "results": result.get("results", []),
    }


def google_search(query: str, page: int = 0) -> dict:
    from urllib.parse import quote_plus
    query = _normalize_query(query)
    url = f"https://www.google.com/search?q={quote_plus(query)}"
    if page:
        url += f"&start={page * 10}"
    return _search(url, query)


def bing_search(query: str, page: int = 0) -> dict:
    from urllib.parse import quote_plus
    query = _normalize_query(query)
    url = f"https://www.bing.com/search?q={quote_plus(query)}"
    if page:
        url += f"&first={page * 10 + 1}"
    return _search(url, query)


def baidu_search(query: str, page: int = 0) -> dict:
    from urllib.parse import quote_plus
    query = _normalize_query(query)
    url = f"https://www.baidu.com/s?wd={quote_plus(query)}"
    if page:
        url += f"&pn={page * 10}"
    return _search(url, query)


def reddit_search(query: str) -> dict:
    from urllib.parse import quote_plus
    return navigate(f"https://www.reddit.com/search/?q={quote_plus(query)}&sort=relevance")
