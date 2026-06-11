"""agent_browser — thread-safe Chrome CDP controller for AI agents.

Quick start:
    from agent_browser import navigate, snapshot, click, type_text, close_browser

    result = navigate("https://example.com")
    print(result["snapshot"])

    snap = snapshot()
    click("e3")
    type_text("hello world")
    close_browser()

For agent frameworks (OpenAI tool calling):
    from agent_browser.tools import TOOL_DEFINITIONS, dispatch

Profile management:
    python -m agent_browser setup-profile   # import system Chrome cookies
    python -m agent_browser login           # open Chrome for manual login
"""
from ._core import (
    navigate,
    snapshot,
    click,
    type_text,
    press_key,
    scroll,
    back,
    close_browser,
    google_search,
    bing_search,
    baidu_search,
    reddit_search,
)
from ._profile import (
    ensure_browser_profile,
    setup_profile,
    login_session,
    cleanup_run_profile,
    cleanup_orphaned_browsers,
)

__all__ = [
    "navigate",
    "snapshot",
    "click",
    "type_text",
    "press_key",
    "scroll",
    "back",
    "close_browser",
    "google_search",
    "bing_search",
    "baidu_search",
    "reddit_search",
    "ensure_browser_profile",
    "setup_profile",
    "login_session",
    "cleanup_run_profile",
    "cleanup_orphaned_browsers",
]
