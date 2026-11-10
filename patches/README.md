# Patches applied to services this extension integrates with.

These modify code we do not own, so each one is written to be idempotent, to fail loudly
when the anchor disappears upstream, and to be worth sending as a PR.

## `agent_display_file.py` — Open WebUI

**What**: `Output.tool()` in `backend/open_webui/utils/agents/output.py` emits
`{"type": "terminal:display_file", "data": {"path": …}}` when an agent tool named
`display_file` completes.

**Why**: the frontend opens a file in its side panel only on that socket event, and Open
WebUI emits it just for chat tool-server calls (`utils/middleware.py`). Agent tool calls
therefore render a card and never open the panel — for every provider, not just Pi.

**Apply** (in an image derived from the one you run):

```dockerfile
USER root
COPY agent_display_file.py /tmp/
RUN python3 /tmp/agent_display_file.py /app/backend/open_webui/utils/agents/output.py \
 && rm /tmp/agent_display_file.py
```

Re-running on a patched file prints `already patched` and exits 0. If upstream renames
`Output.tool()` the patch exits 1 instead of silently doing nothing.

**Check**: `docker logs open-webui | grep "agent display_file ->"` after an agent calls the
tool.
