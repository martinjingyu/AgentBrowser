from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

# ---------------------------------------------------------------------------
# CLI path resolution
# ---------------------------------------------------------------------------

def _find_cli() -> Path:
    candidates = [
        Path(__file__).parent / "data" / "cli.js",        # installed package (pip install .)
        Path(__file__).parent.parent / "src" / "cli.js",  # editable install (pip install -e .)
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
# Port + thread-slot allocation
# ---------------------------------------------------------------------------

_PROC_PID = os.getpid()
_BROWSER_PORT_BASE = int(os.getenv("AGENT_BROWSER_PORT", str(9222 + (_PROC_PID % 100) * 10)))
_BROWSER_INSTANCE_BASE = os.getenv("AGENT_BROWSER_INSTANCE", str(_PROC_PID))

_thread_local = threading.local()
_slot_lock = threading.Lock()
_slot_counter = [0]

_active_ports: set[int] = set()
_active_ports_lock = threading.Lock()


def _thread_slot() -> tuple[int, str, int]:
    """Return (port, instance_id, slot_index) unique to the calling thread, allocated lazily."""
    if not hasattr(_thread_local, "port"):
        with _slot_lock:
            idx = _slot_counter[0]
            _slot_counter[0] += 1
        _thread_local.port = _BROWSER_PORT_BASE + idx
        _thread_local.instance = (
            _BROWSER_INSTANCE_BASE if idx == 0
            else f"{_BROWSER_INSTANCE_BASE}_t{idx}"
        )
        _thread_local.idx = idx
    return _thread_local.port, _thread_local.instance, _thread_local.idx


def _mark_port_active(port: int) -> None:
    with _active_ports_lock:
        _active_ports.add(port)


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
    with _active_ports_lock:
        ports = set(_active_ports)
    for port in ports:
        _kill_chrome_on_port(port)


atexit.register(_atexit_cleanup)


# ---------------------------------------------------------------------------
# Profile management for worker threads
# ---------------------------------------------------------------------------

def _ensure_worker_profile(instance: str) -> str:
    """Copy the run profile to a per-thread directory on first use."""
    if getattr(_thread_local, "profile_ready", False):
        return instance

    from ._profile import _profiles_dir
    dest = _profiles_dir() / instance
    if not dest.exists():
        run_profile = os.environ.get("AGENT_BROWSER_PROFILE", "")
        src = _profiles_dir() / run_profile if run_profile else None
        if src and src.exists():
            try:
                def _copy2_skip_locked(s, d):
                    try:
                        shutil.copy2(s, d)
                    except OSError:
                        pass

                shutil.copytree(
                    src, dest,
                    ignore=shutil.ignore_patterns("*.tmp", "LOG", "LOCK", "*.lock"),
                    copy_function=_copy2_skip_locked,
                )
                print(f"[Browser] Copied run profile → profiles/{instance}/")
            except Exception as e:
                print(f"[Browser] Could not copy run profile for {instance}: {e}")

    _thread_local.profile_ready = True
    return instance


def _cli_env() -> dict[str, str]:
    """Build subprocess env dict for the calling thread's browser slot."""
    from ._profile import ensure_browser_profile, _profiles_dir
    ensure_browser_profile()

    port, instance, idx = _thread_slot()
    env = dict(os.environ)
    env["AGENT_BROWSER_PORT"] = str(port)
    env["AGENT_BROWSER_INSTANCE"] = instance
    # Per-thread state dir prevents refs.json from being shared across parallel instances
    env["AGENT_BROWSER_STATE_DIR"] = str(Path.home() / ".agentbrowser" / instance)
    env["AGENT_BROWSER_PROFILES_DIR"] = str(_profiles_dir())
    if idx != 0:
        env["AGENT_BROWSER_PROFILE"] = _ensure_worker_profile(instance)
    return env


# ---------------------------------------------------------------------------
# CLI runner
# ---------------------------------------------------------------------------

def _run(command: str, *args: str, timeout: int = 60) -> dict:
    """Run agentBrowser CLI. Returns dict with at least {"success": bool}."""
    cli = _find_cli()
    cmd = ["node", str(cli), command, *args]
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW

    env = _cli_env()
    port, _, _ = _thread_slot()
    _mark_port_active(port)

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


def _run_recovering(command: str, *args: str, timeout: int = 60) -> dict:
    """Run a CDP command; on session freeze restart the browser and retry once."""
    result = _run(command, *args, timeout=timeout)
    if not result.get("success") and "CDP command timed out" in result.get("error", ""):
        print(f"[Browser] CDP timeout on '{command}', restarting and retrying...")
        close_browser()
        result = _run(command, *args, timeout=timeout)
    return result


# ---------------------------------------------------------------------------
# Public browser functions
# ---------------------------------------------------------------------------

_NAVIGATE_SNAPSHOT_LIMIT = 8000


def navigate(url: str) -> dict:
    """Navigate to URL and return a truncated snapshot of the loaded page."""
    result = _run_recovering("open", url, timeout=30)
    if not result.get("success"):
        return result
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


def close_browser() -> dict:
    """Close the Chrome instance for this thread."""
    port, _, _ = _thread_slot()
    _run("close", timeout=15)
    _kill_chrome_on_port(port)
    with _active_ports_lock:
        _active_ports.discard(port)
    return {"success": True}


# ---------------------------------------------------------------------------
# Search helpers
# ---------------------------------------------------------------------------

def google_search(query: str) -> dict:
    from urllib.parse import quote_plus
    return navigate(f"https://www.google.com/search?q={quote_plus(query)}")


def bing_search(query: str) -> dict:
    from urllib.parse import quote_plus
    return navigate(f"https://www.bing.com/search?q={quote_plus(query)}")


def baidu_search(query: str) -> dict:
    from urllib.parse import quote_plus
    return navigate(f"https://www.baidu.com/s?wd={quote_plus(query)}")


def reddit_search(query: str) -> dict:
    from urllib.parse import quote_plus
    return navigate(f"https://www.reddit.com/search/?q={quote_plus(query)}&sort=relevance")
