"""Emit Open WebUI's task checklist event for agent tool calls.

The frontend renders a checklist from

    {"type": "chat:message:tasks", "data": {"tasks": [{"content": ..., "status": ...}]}}

Open WebUI emits that only for its chat tools (`tools/builtin.py`). This patch adds it to
`Output.tool()` so an agent tool named `set_tasks` gets the same checklist.

Idempotent: re-running on a patched file changes nothing. The checklist is live page state,
not history — Open WebUI does not persist it, so it disappears on reload.

Usage: python3 agent_tasks.py /app/backend/open_webui/utils/agents/output.py
"""

import pathlib
import sys

MARKER = "agent set_tasks -> emitting chat:message:tasks"

ANCHOR = """
    async def approve("""

PATCH = """        # Agent task list, mirroring what chat tools emit for create_tasks.
        if done and name == "set_tasks":
            arguments = arguments if isinstance(arguments, dict) else {}
            raw_tasks = arguments.get("tasks")
            if isinstance(raw_tasks, list) and raw_tasks:
                tasks = []
                for index, entry in enumerate(raw_tasks):
                    if isinstance(entry, str):
                        tasks.append({"id": f"task-{index}", "content": entry, "status": "pending"})
                    elif isinstance(entry, dict) and entry.get("content"):
                        tasks.append(
                            {
                                "id": str(entry.get("id") or f"task-{index}"),
                                "content": str(entry["content"]),
                                "status": str(entry.get("status") or "pending"),
                            }
                        )
                if tasks:
                    log.info("agent set_tasks -> emitting chat:message:tasks (%d)", len(tasks))
                    if self.emitter:
                        await self.emitter({"type": "chat:message:tasks", "data": {"tasks": tasks}})
                    else:
                        log.warning("agent set_tasks -> no emitter for chat %s", self.metadata.get("chat_id"))

    async def approve("""


def main(path: str) -> int:
    file = pathlib.Path(path)
    source = file.read_text()

    if MARKER in source:
        print("already patched")
        return 0
    if ANCHOR not in source:
        print("anchor not found: agent Output.tool() has changed upstream", file=sys.stderr)
        return 1

    file.write_text(source.replace(ANCHOR, "\n" + PATCH, 1))
    print(f"patched {file}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
