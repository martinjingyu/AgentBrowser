from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path


def _profiles_dir() -> Path:
    env = os.environ.get("AGENT_BROWSER_PROFILES_DIR")
    return Path(env) if env else Path.home() / ".agentbrowser" / "profiles"


_DEFAULT_CHROME_USER_DATA = Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"

_CACHE_DIRS = shutil.ignore_patterns(
    "Cache", "Code Cache", "GPUCache", "ShaderCache",
    "DawnWebGPUCache", "DawnGraphiteCache", "GrShaderCache", "GraphiteDawnCache",
    "optimization_guide_model_store", "Crashpad",
)

_prepared = False


def ensure_browser_profile() -> None:
    """Set AGENT_BROWSER_PROFILE to a per-run scratch copy of the shared profile.

    Safe to call multiple times — only runs once per process.
    If AGENT_BROWSER_PROFILE is already set, does nothing.
    If no shared profile exists yet, the agent runs with a fresh empty profile.
    """
    global _prepared
    if _prepared:
        return
    _prepared = True

    if os.environ.get("AGENT_BROWSER_PROFILE"):
        return

    profiles = _profiles_dir()
    shared = profiles / "shared"
    if not shared.exists():
        return

    run_slot = f"run_{os.getpid()}"
    dest = profiles / run_slot
    if not dest.exists():
        try:
            shutil.copytree(shared, dest, ignore=_CACHE_DIRS)
            print(f"[Browser] Copied shared profile → profiles/{run_slot}/")
        except Exception as e:
            print(f"[Browser] Could not copy shared profile: {e}")
            return

    os.environ["AGENT_BROWSER_PROFILE"] = run_slot


def cleanup_run_profile() -> None:
    """Delete the per-run scratch profile created by ensure_browser_profile()."""
    slot = os.environ.get("AGENT_BROWSER_PROFILE", "")
    if not slot.startswith("run_"):
        return
    dest = _profiles_dir() / slot
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
        print(f"[Browser] Cleaned up scratch profile: {slot}")


def cleanup_orphaned_browsers() -> None:
    """Kill Chrome processes and delete profile dirs left by previously killed runs."""
    import re
    profiles = _profiles_dir()
    if not profiles.exists():
        return

    my_pid = os.getpid()

    for p in list(profiles.iterdir()):
        if not p.is_dir():
            continue
        m = re.fullmatch(r"run_(\d+)", p.name)
        if not m:
            continue
        old_pid = int(m.group(1))
        if old_pid == my_pid or _pid_running(old_pid):
            continue

        _kill_chrome_using_profile(str(p))
        shutil.rmtree(p, ignore_errors=True)
        print(f"[Browser] Removed orphaned profile from dead run (PID {old_pid}): {p.name}")


def _pid_running(pid: int) -> bool:
    try:
        if os.name == "nt":
            r = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5, creationflags=0x08000000,
            )
            return f'"{pid}"' in r.stdout
        else:
            return Path(f"/proc/{pid}").exists()
    except Exception:
        return True


def _kill_chrome_using_profile(profile_path: str) -> None:
    try:
        if os.name == "nt":
            escaped = profile_path.replace("\\", "\\\\").replace("'", "\\'")
            r = subprocess.run(
                ["powershell", "-Command",
                 f"Get-WmiObject Win32_Process | Where-Object {{"
                 f" $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*{escaped}*'"
                 f"}} | Select-Object -ExpandProperty ProcessId"],
                capture_output=True, text=True, timeout=10, creationflags=0x08000000,
            )
            for line in r.stdout.splitlines():
                line = line.strip()
                if line.isdigit():
                    subprocess.run(
                        ["taskkill", "/F", "/PID", line],
                        capture_output=True, timeout=5, creationflags=0x08000000,
                    )
        else:
            subprocess.run(["pkill", "-f", profile_path], capture_output=True, timeout=5)
    except Exception:
        pass


def login_session() -> None:
    """Open Chrome with the shared agent profile so you can log in manually."""
    profiles = _profiles_dir()
    profile_dir = profiles / "shared"
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "Default").mkdir(parents=True, exist_ok=True)

    chrome = _find_chrome()
    print(f"[Browser] Opening Chrome with agent profile: {profile_dir}")
    print("[Browser] Log in to any sites you need, then CLOSE Chrome completely.")
    print("[Browser] Cookies will be saved automatically to the shared profile.")

    subprocess.Popen([
        chrome,
        f"--user-data-dir={profile_dir}",
        "--profile-directory=Default",
        "--no-first-run",
        "--no-default-browser-check",
        "https://github.com",
    ]).wait()

    print("[Browser] Chrome closed. Shared profile updated with your login sessions.")


def setup_profile(profile_name: str | None = None) -> None:
    """Copy one Chrome profile into profiles/shared/Default/ for agent reuse."""
    user_data = _DEFAULT_CHROME_USER_DATA
    if not user_data.exists():
        raise FileNotFoundError(f"Chrome User Data dir not found: {user_data}")

    src_profile = (
        _find_profile(user_data, profile_name) if profile_name
        else _detect_main_profile(user_data)
    )
    print(f"[Browser] Using Chrome profile: {src_profile.name}")

    profiles = _profiles_dir()
    dest = profiles / "shared"
    if dest.exists():
        print(f"[Browser] Removing existing shared profile: {dest}")
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    local_state = user_data / "Local State"
    if local_state.exists():
        _copy_local_state(local_state, dest / "Local State")

    dest_default = dest / "Default"
    print(f"[Browser] Copying {src_profile} → {dest_default} (cache dirs skipped)...")
    shutil.copytree(src_profile, dest_default, ignore=_CACHE_DIRS)

    for db_relpath in ("Network/Cookies", "Login Data", "Web Data"):
        src_db = src_profile / db_relpath
        dst_db = dest_default / db_relpath
        if src_db.exists() and dst_db.exists():
            _sqlite_backup(src_db, dst_db)

    cookies = dest_default / "Network" / "Cookies"
    if cookies.exists():
        n = sqlite3.connect(str(cookies)).execute("SELECT COUNT(*) FROM cookies").fetchone()[0]
        print(f"[Browser] Cookies: {n} entries ({cookies.stat().st_size:,} bytes).")
        if n < 10:
            print("[Browser] WARNING: very few cookies — was Chrome open? Run again with Chrome closed.")
    else:
        print("[Browser] WARNING: Network/Cookies not found.")

    print("[Browser] Done. Run 'agent-browser login' to log in manually instead.")


def _find_chrome() -> str:
    for candidate in [
        os.environ.get("CHROME_PATH"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
    ]:
        if candidate and Path(candidate).exists():
            return candidate
    raise FileNotFoundError("Chrome not found. Set CHROME_PATH to chrome.exe.")


def _find_profile(user_data: Path, name: str) -> Path:
    p = user_data / name
    if not p.exists():
        raise FileNotFoundError(f"Chrome profile '{name}' not found in {user_data}")
    return p


def _detect_main_profile(user_data: Path) -> Path:
    candidates: list[tuple[int, Path]] = []
    for sub in user_data.iterdir():
        if not sub.is_dir():
            continue
        cookies = sub / "Network" / "Cookies"
        if cookies.exists():
            candidates.append((cookies.stat().st_size, sub))
    if not candidates:
        default = user_data / "Default"
        return default if default.exists() else next(user_data.iterdir())
    candidates.sort(reverse=True)
    best = candidates[0][1]
    print(f"[Browser] Auto-detected profile: {best.name} (cookies {candidates[0][0]:,} bytes)")
    return best


def _sqlite_backup(src: Path, dst: Path) -> None:
    try:
        src_conn = sqlite3.connect(f"file:{src}?mode=ro&immutable=1", uri=True)
        dst_conn = sqlite3.connect(str(dst))
        with dst_conn:
            src_conn.backup(dst_conn)
        src_conn.close()
        dst_conn.close()
    except Exception as e:
        print(f"[Browser] SQLite backup failed for {src.name}: {e} (keeping shutil copy)")


def _copy_local_state(src: Path, dest: Path) -> None:
    try:
        data = json.loads(src.read_bytes())
    except Exception:
        shutil.copy2(src, dest)
        return

    src_cache = data.get("profile", {}).get("info_cache", {})
    display_name = next(
        (v.get("name", "") for v in src_cache.values() if isinstance(v, dict) and v.get("name")),
        "",
    )
    data["profile"] = {
        "last_used": "Default",
        "last_active_profiles": ["Default"],
        "info_cache": {"Default": {"name": display_name or "Agent", "is_using_default_name": True}},
    }
    dest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
