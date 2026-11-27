"""Smoke test: start server.py over stdio, list tools, call extract_data and get_job.

Usage: .venv/bin/python test_client.py [url]   (default https://books.toscrape.com/)
"""
import asyncio
import json
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = os.path.dirname(os.path.abspath(__file__))
URL = sys.argv[1] if len(sys.argv) > 1 else "https://books.toscrape.com/"


def show(label, result):
    print(f"\n=== {label} (isError={result.isError})")
    data = result.structuredContent
    if data is None:  # fall back to the text content
        print("\n".join(getattr(c, "text", str(c)) for c in result.content))
        return None
    data = data.get("result", data)
    shown = json.loads(json.dumps(data))  # deep copy; trimming below is display-only
    if isinstance(shown.get("results"), list) and len(shown["results"]) > 5:
        shown["results"] = shown["results"][:5] + [f"... {len(data['results']) - 5} more"]
    for e in shown.get("security_events") or []:
        if isinstance(e.get("detail"), str) and len(e["detail"]) > 110:
            e["detail"] = e["detail"][:110] + "..."
    print(json.dumps(shown, indent=2, ensure_ascii=False))
    return data


async def main():
    params = StdioServerParameters(command=sys.executable, args=[os.path.join(HERE, "server.py")], env={**os.environ})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print("tools:", [t.name for t in tools.tools])

            data = show(f"extract_data({URL})", await session.call_tool("extract_data", {"url": URL}))
            if data and data.get("job_id"):
                again = show(f"get_job({data['job_id']}) [results trimmed]", await session.call_tool("get_job", {"job_id": data["job_id"]}))
                print("\nget_job matches extract_data:", again == data)
            show("get_job('nope') [expected error]", await session.call_tool("get_job", {"job_id": "nope"}))


if __name__ == "__main__":
    asyncio.run(main())
