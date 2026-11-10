# Open WebUI custom tools

Custom tools that run **inside Open WebUI** (its own tool runtime), kept here so they are
versioned next to the Pi extension that consumes them.

This is the counterpart of `extension/`: the extension gives Pi access to Open WebUI
data; a tool here gives Open WebUI's own chats a capability we wrote ourselves.

## What a tool looks like

An Open WebUI tool is a single Python file exposing a `Tools` class. Public methods
become model-callable tools; their docstrings are the tool description. A nested `Valves`
class holds settings that admins edit in the UI.

```python
"""
title: Example tool
description: What this tool does, in one line.
required_open_webui_version: 0.6.0
requirements: httpx
"""

from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        endpoint: str = Field("", description="Upstream HTTP endpoint")
        timeout: float = Field(10.0, description="Request timeout in seconds")

    def __init__(self):
        self.valves = self.Valves()

    async def my_tool(self, query: str) -> str:
        """
        One-paragraph description of when the model should call this.

        :param query: What the argument means.
        :return: What the model gets back.
        """
        return query
```

See `example_http_lookup.py` for a working template with error handling.

## Install

Open WebUI loads tools from its database, not from disk:

1. Workspace → Tools → **+** → paste the file contents (or import it).
2. Set the Valves in the tool's settings, then enable it for a model.

Installing from the API is also possible, with an admin key:

```sh
curl -s -X POST "$OPEN_WEBUI_BASE_URL/api/v1/tools/create" \
  -H "Authorization: Bearer $OPEN_WEBUI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(python3 - <<'PY'
import json
src = open("owui-tools/example_http_lookup.py").read()
print(json.dumps({"id": "example_http_lookup", "name": "Example HTTP lookup", "content": src}))
PY
)"
```

## What *not* to put here

Tools that need the chat UI cannot be driven from a terminal agent, so they are not
useful as a bridge to Pi: `ask_user` needs `__event_call__` (a browser event channel),
`display_file` needs the chat's rendered state, `create_tasks` renders in the Open WebUI
message, `notify` targets the user's notification settings. If a bridge is ever wanted,
those need Open WebUI changes, not a tool file.

## Relation to the Pi extension

| Capability | Who provides it |
|---|---|
| Notes, knowledge bases, memories, skills → Pi | `extension/` (this repo) over `/api/v1/*` |
| Web search / page fetch → Pi | `extension/tools/web.ts` over `/api/v1/retrieval/*` |
| A capability Open WebUI chats need | a tool in this directory |
