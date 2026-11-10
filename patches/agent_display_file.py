"""Teach Open WebUI's agent output to emit the terminal file-preview event.

Open WebUI opens a file in its side panel when the backend emits

    {"type": "terminal:display_file", "data": {"path": ...}}

That emission exists only for the chat tool-server path (`utils/middleware.py`), so an
agent tool named `display_file` shows a card instead of opening the panel. This patch adds
the same emission to `Output.tool()` — the single choke point for agent tool results — so
every agent provider (Pi, Codex, Claude Code, ACP) behaves like a terminal tool.

Idempotent: re-running on a patched file changes nothing.

Usage: python3 agent_display_file.py /app/backend/open_webui/utils/agents/output.py
"""

import pathlib
import sys

MARKER = "agent display_file -> emitting terminal:display_file"

ANCHOR = """        await self.flush(force=True)

    async def approve("""

PATCH = """        await self.flush(force=True)

        # Agent tool calls must open the file panel just like terminal tool calls do.
        # Providers hand us different shapes, so accept the path from the result payload
        # or, like the chat tool path, from the call arguments.
        if done and name == "display_file":
            candidate = result
            if isinstance(candidate, str):
                try:
                    candidate = json.loads(candidate)
                except Exception:
                    candidate = None
            if not isinstance(candidate, dict):
                candidate = {}
            if not isinstance(candidate.get("path"), str):
                for key in ("structuredContent", "structured_content", "details", "output"):
                    nested = candidate.get(key)
                    if isinstance(nested, dict) and isinstance(nested.get("path"), str):
                        candidate = nested
                        break

            arguments = arguments if isinstance(arguments, dict) else {}
            path = candidate.get("path") if isinstance(candidate.get("path"), str) else arguments.get("path")
            page = candidate.get("page") or arguments.get("page")
            # Same rule as the chat tool path: an inline result is rendered in the message,
            # so it must not also steal the side panel.
            inline = candidate.get("displayed") is True or arguments.get("inline") is True

            if path:
                mime_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
                terminal_selector = self.metadata.get("terminal_id")
                file_item = {
                    "type": "file",
                    "source": "open_terminal",
                    "terminal_selector": terminal_selector,
                    "session_id": self.metadata.get("chat_id"),
                    "path": path,
                    "full_path": path,
                    "name": os.path.basename(path),
                    "mime_type": mime_type,
                    "content_type": mime_type,
                    "exists": True,
                    "displayed": inline,
                    **({"page": page} if page else {}),
                    **({"terminal_id": terminal_selector} if terminal_selector else {}),
                }
                # The chat frontend builds its file card from this shape, so replace the
                # plain tool output instead of appending a second item.
                for entry in reversed(self.items):
                    if entry.get("type") == "function_call_output" and entry.get("call_id") == call_id:
                        entry["output"] = [{"type": "input_text", "text": json.dumps(file_item)}]
                        break

                if inline:
                    log.info("agent display_file -> inline render for %s", path)
                else:
                    log.info("agent display_file -> emitting terminal:display_file for %s", path)
                    if self.emitter:
                        await self.emitter(
                            {
                                "type": "terminal:display_file",
                                "data": {"path": path, **({"page": page} if page else {})},
                            }
                        )
                    else:
                        log.warning("agent display_file -> no emitter for chat %s", self.metadata.get("chat_id"))

    async def approve("""

LOGGER_IMPORT = ('from open_webui.utils.tool_permissions import requires_tool_approval\n',
                 'from open_webui.utils.tool_permissions import requires_tool_approval\n\nlog = logging.getLogger(__name__)\n')
LOGGING_IMPORT = ("import json\n", "import json\nimport logging\nimport mimetypes\nimport os\n")


def main(path: str) -> int:
    file = pathlib.Path(path)
    source = file.read_text()

    if MARKER in source:
        print("already patched")
        return 0
    if ANCHOR not in source:
        print("anchor not found: agent Output.tool() has changed upstream", file=sys.stderr)
        return 1

    if "import logging" not in source:
        source = source.replace(*LOGGING_IMPORT, 1)
    if "log = logging.getLogger(__name__)" not in source:
        source = source.replace(*LOGGER_IMPORT, 1)

    file.write_text(source.replace(ANCHOR, PATCH, 1))
    print(f"patched {file}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
