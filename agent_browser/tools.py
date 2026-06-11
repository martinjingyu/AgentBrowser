"""OpenAI-compatible tool definitions for agent frameworks.

Usage:
    from agent_browser.tools import TOOL_DEFINITIONS, dispatch

    # Pass definitions to your LLM
    response = openai_client.chat.completions.create(
        model="...",
        messages=[...],
        tools=TOOL_DEFINITIONS,
    )

    # Dispatch tool calls from the response
    for tc in response.choices[0].message.tool_calls:
        import json
        args = json.loads(tc.function.arguments)
        result = dispatch(tc.function.name, args)
        # result is a JSON string
"""
from __future__ import annotations

import json

TOOL_DEFINITIONS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "browser_navigate",
            "description": (
                "Navigate to a URL. Returns a snapshot of the loaded page including @ref IDs for every "
                "interactive element (links, buttons, inputs). Use @ref values with browser_click or "
                "browser_type. Prefer browser_click for in-page navigation."
            ),
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_snapshot",
            "description": (
                "Refresh and return the current page's accessibility snapshot with @ref IDs. "
                "Call after browser_click or browser_type to see updated page content. "
                "Not needed right after browser_navigate."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_click",
            "description": (
                "Click an interactive element by its @ref ID (e.g. 'e5' or '@e5'). "
                "@ref IDs come from browser_navigate or browser_snapshot. "
                "After clicking, call browser_snapshot to see updated page state."
            ),
            "parameters": {
                "type": "object",
                "properties": {"ref": {"type": "string"}},
                "required": ["ref"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_type",
            "description": (
                "Type text into the currently focused element. "
                "First click the target input field with browser_click to focus it."
            ),
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_press_key",
            "description": "Press a keyboard key (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown').",
            "parameters": {
                "type": "object",
                "properties": {"key": {"type": "string"}},
                "required": ["key"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_scroll",
            "description": "Scroll the page up or down.",
            "parameters": {
                "type": "object",
                "properties": {
                    "direction": {"type": "string", "enum": ["up", "down"], "default": "down"},
                    "pixels": {"type": "integer", "default": 600},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_back",
            "description": "Navigate back in browser history.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "google_search",
            "description": (
                "Search Google. Returns a snapshot of the search results page. "
                "Prefer for academic pages and international content."
            ),
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bing_search",
            "description": (
                "Search Bing. Returns a snapshot of the search results page. "
                "Good for general web searches and finding official pages."
            ),
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "baidu_search",
            "description": "Search Baidu. Use for Chinese-language content and mainland China sites.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reddit_search",
            "description": "Search Reddit for community discussions, reviews, and first-hand accounts.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_close",
            "description": (
                "Close the Chrome instance for this thread and release the browser port. "
                "Call when done with all browser actions to free resources. "
                "The browser will be restarted automatically if browser tools are called again."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]

_TOOL_NAMES = {d["function"]["name"] for d in TOOL_DEFINITIONS}


def dispatch(name: str, args: dict) -> str:
    """Dispatch a tool call by name. Returns a JSON string result."""
    from . import _core as c

    handlers: dict = {
        "browser_navigate":  lambda a: c.navigate(a["url"]),
        "browser_snapshot":  lambda a: c.snapshot(),
        "browser_click":     lambda a: c.click(a["ref"]),
        "browser_type":      lambda a: c.type_text(a["text"]),
        "browser_press_key": lambda a: c.press_key(a["key"]),
        "browser_scroll":    lambda a: c.scroll(a.get("direction", "down"), int(a.get("pixels", 600))),
        "browser_back":      lambda a: c.back(),
        "google_search":     lambda a: c.google_search(a["query"]),
        "bing_search":       lambda a: c.bing_search(a["query"]),
        "baidu_search":      lambda a: c.baidu_search(a["query"]),
        "reddit_search":     lambda a: c.reddit_search(a["query"]),
        "browser_close":     lambda a: c.close_browser(),
    }

    handler = handlers.get(name)
    if handler is None:
        return json.dumps({"success": False, "error": f"Unknown tool: {name}"}, ensure_ascii=False)

    try:
        result = handler(args)
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)
