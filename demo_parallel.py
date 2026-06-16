"""
Demo: parallel agents each controlling their own independent browser tab.

All agents share ONE Chrome process on one port. Each agent gets its own
tab (CDP Target), isolated via ContextVar — no port-per-thread limit.

Run:
    python demo_parallel.py
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed

import agent_browser as ab


# ---------------------------------------------------------------------------
# Thread-based parallel agents
# ---------------------------------------------------------------------------

def agent_task(task_id: int, url: str) -> dict:
    """Each thread auto-creates its own browser tab on first call."""
    # navigate() auto-creates a session for this thread's context
    session = ab.create_session()
    print(f"[Task {task_id}] created tab  target_id={session['target_id'][:8]}...")

    # In a real agent you'd call ab.navigate(url), ab.snapshot(), ab.click(), etc.
    # Here we just verify each thread gets a unique target_id.

    result = ab.close_session()
    print(f"[Task {task_id}] closed tab: {result}")
    return {"task_id": task_id, "target_id": session["target_id"], "closed": result["success"]}


def demo_threads():
    urls = [
        "https://example.com",
        "https://google.com",
        "https://github.com",
        "https://arxiv.org",
    ]

    print("=== Thread-based parallel demo ===")
    print(f"Launching {len(urls)} parallel tasks (one Chrome, {len(urls)} tabs)...\n")

    results = []
    with ThreadPoolExecutor(max_workers=len(urls)) as pool:
        futures = {pool.submit(agent_task, i, url): i for i, url in enumerate(urls)}
        for future in as_completed(futures):
            results.append(future.result())

    target_ids = [r["target_id"] for r in results]
    assert len(set(target_ids)) == len(results), f"target_ids not unique: {target_ids}"
    assert all(r["closed"] for r in results), "Some sessions failed to close"

    print("\n=== Thread results ===")
    for r in sorted(results, key=lambda x: x["task_id"]):
        print(f"  task={r['task_id']}  target={r['target_id'][:12]}...  closed=OK")
    print(f"\nPASS: {len(results)} parallel tabs in one Chrome, all closed.\n")


# ---------------------------------------------------------------------------
# Asyncio-based parallel agents
# ---------------------------------------------------------------------------

async def agent_coroutine(task_id: int, url: str) -> dict:
    """Each asyncio Task auto-creates its own browser tab."""
    # Run blocking subprocess calls in a thread pool to avoid blocking the event loop
    session = await asyncio.to_thread(ab.create_session)
    print(f"[Coro {task_id}] created tab  target_id={session['target_id'][:8]}...")

    # await asyncio.to_thread(ab.navigate, url)  # real usage
    # await asyncio.to_thread(ab.snapshot)

    result = await asyncio.to_thread(ab.close_session)
    print(f"[Coro {task_id}] closed tab: {result}")
    return {"task_id": task_id, "target_id": session["target_id"], "closed": result["success"]}


async def demo_asyncio():
    urls = [
        "https://example.com",
        "https://google.com",
        "https://github.com",
        "https://arxiv.org",
    ]

    print("=== Asyncio-based parallel demo ===")
    print(f"Launching {len(urls)} coroutines (one Chrome, {len(urls)} tabs)...\n")

    results = await asyncio.gather(*[agent_coroutine(i, url) for i, url in enumerate(urls)])

    target_ids = [r["target_id"] for r in results]
    assert len(set(target_ids)) == len(results), f"target_ids not unique: {target_ids}"
    assert all(r["closed"] for r in results), "Some sessions failed to close"

    print("\n=== Asyncio results ===")
    for r in sorted(results, key=lambda x: x["task_id"]):
        print(f"  task={r['task_id']}  target={r['target_id'][:12]}...  closed=OK")
    print(f"\nPASS: {len(results)} parallel tabs in one Chrome, all closed.\n")


if __name__ == "__main__":
    demo_threads()
    asyncio.run(demo_asyncio())

    print("=== Profile management ===")
    print("To set up a shared profile (import cookies from Chrome):")
    print("  python -m agent_browser setup-profile")
    print("  agent-browser setup-profile")
    print("")
    print("To log in manually:")
    print("  python -m agent_browser login")
    print("  agent-browser login")
