"""agent_browser — Chrome CDP controller for AI agents, with asyncio and thread support.

Quick start:
    from agent_browser import navigate, snapshot, click, type_text, close_session

    result = navigate("https://example.com")
    print(result["snapshot"])

    snap = snapshot()
    click("e3")
    type_text("hello world")
    close_session()

Parallel agents (asyncio):
    import asyncio, agent_browser as ab

    async def agent(url):
        # Each task auto-creates its own browser tab on first call
        result = await asyncio.to_thread(ab.navigate, url)
        await asyncio.to_thread(ab.close_session)

    asyncio.run(asyncio.gather(agent("https://a.com"), agent("https://b.com")))

Parallel agents (threads):
    from concurrent.futures import ThreadPoolExecutor
    import agent_browser as ab

    def agent(url):
        ab.navigate(url)   # auto-creates a tab for this thread
        ab.close_session()

    with ThreadPoolExecutor(max_workers=10) as pool:
        pool.map(agent, urls)

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
    create_session,
    close_session,
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
    "create_session",
    "close_session",
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
