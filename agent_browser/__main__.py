"""python -m agent_browser <command>

Commands:
  setup-profile [name]   Copy a Chrome profile (with cookies) into the shared agent profile.
                         Omit name to auto-detect the profile with the most cookies.
                         Run with Chrome closed for a complete cookie copy.

  login                  Open Chrome with the shared agent profile so you can log in manually.
                         Close Chrome when done — cookies are saved automatically.

  info                   Show paths and environment state.
"""
from __future__ import annotations

import sys


def main() -> None:
    args = sys.argv[1:]
    cmd = args[0] if args else "help"

    if cmd in ("help", "--help", "-h"):
        print(__doc__)
        return

    if cmd == "setup-profile":
        from ._profile import setup_profile
        profile_name = args[1] if len(args) > 1 else None
        setup_profile(profile_name)
        return

    if cmd == "login":
        from ._profile import login_session
        login_session()
        return

    if cmd == "info":
        from ._profile import _profiles_dir
        from ._core import _find_cli, _BROWSER_PORT_BASE
        import os
        print(f"CLI path:      {_find_cli()}")
        print(f"Profiles dir:  {_profiles_dir()}")
        print(f"Port base:     {_BROWSER_PORT_BASE}")
        print(f"AGENT_BROWSER_PROFILE: {os.environ.get('AGENT_BROWSER_PROFILE', '(not set)')}")
        return

    print(f"Unknown command: {cmd}")
    print(__doc__)
    sys.exit(1)


if __name__ == "__main__":
    main()
