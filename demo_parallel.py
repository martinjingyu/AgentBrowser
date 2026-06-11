"""
Demo: parallel agents each controlling their own independent Chrome instance.

Run:
    python demo_parallel.py

Each worker thread:
  1. Gets its own unique Chrome port and profile dir
  2. Navigates to a URL
  3. Calls close_browser() to clean up

No Chrome is actually launched here because the demo runs without real navigation —
it only shows port/slot allocation and close behavior. To do real browsing, call
navigate() and the CLI will start Chrome automatically.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import agent_browser as ab
from agent_browser._core import _thread_slot, _cli_env, close_browser


def agent_task(task_id: int, url: str) -> dict:
    """Simulates what a browser agent does: get slot → do work → close browser."""
    port, instance, idx = _thread_slot()
    env = _cli_env()

    print(
        f"[Task {task_id}] port={port}  instance={instance}  "
        f"state_dir=.../{env['AGENT_BROWSER_STATE_DIR'].split('/')[-1].split(chr(92))[-1]}"
    )

    # In a real agent you'd call ab.navigate(url), ab.snapshot(), ab.click(), etc.
    # Here we just verify isolation by checking each thread has a unique port.
    time.sleep(0.1)  # simulate work

    result = close_browser()
    print(f"[Task {task_id}] done, browser closed: {result}")
    return {"task_id": task_id, "port": port, "instance": instance, "closed": result["success"]}


def main():
    urls = [
        "https://example.com",
        "https://google.com",
        "https://github.com",
        "https://arxiv.org",
    ]

    print("=== Parallel browser demo ===")
    print(f"Launching {len(urls)} parallel tasks...\n")

    results = []
    with ThreadPoolExecutor(max_workers=len(urls)) as pool:
        futures = {pool.submit(agent_task, i, url): i for i, url in enumerate(urls)}
        for future in as_completed(futures):
            results.append(future.result())

    print("\n=== Results ===")
    ports = [r["port"] for r in results]
    instances = [r["instance"] for r in results]

    assert len(set(ports)) == len(results), f"Ports not unique: {ports}"
    assert len(set(instances)) == len(results), f"Instances not unique: {instances}"
    assert all(r["closed"] for r in results), "Some browsers failed to close"

    for r in sorted(results, key=lambda x: x["port"]):
        print(f"  task={r['task_id']}  port={r['port']}  instance={r['instance']}  closed=OK")

    print(f"\nPASS: {len(results)} parallel browsers, all independent, all closed.")

    print("\n=== Profile management ===")
    print("To set up a shared profile (import cookies from Chrome):")
    print("  python -m agent_browser setup-profile")
    print("  agent-browser setup-profile")
    print("")
    print("To log in manually:")
    print("  python -m agent_browser login")
    print("  agent-browser login")
    print("")
    print("To check current state:")
    print("  python -m agent_browser info")


if __name__ == "__main__":
    main()
