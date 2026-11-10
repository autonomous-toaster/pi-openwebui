# pi-openwebui

Exposes Open WebUI to the Pi coding agent — notes, knowledge bases, memories, web search,
skills, MCP servers — and lets the agent act on the conversation it is running in.

Built for Open WebUI ≥ 0.13, where a coding agent runs inside an `open-terminal` workspace
and receives only a prompt: no tools, no RAG, no skills. This closes that gap from the
agent side.

## Tools

| Tool | Actions | Notes |
|---|---|---|
| `owui_notes` | `list`, `search`, `read`, `create`, `append` | Reads are sliced; append passes the page revision so a browser edit wins with a 409 |
| `owui_knowledge` | `list`, `files`, `search`, `read`, `query`, `create`, `add`, `remove`, `delete` | `search` is free SQL `LIKE`, `query` is vector retrieval, `add` indexes workspace files (costs embeddings); `delete` refuses unless the name is repeated back |
| `owui_memory` | `list`, `search`, `add`, `update`, `delete` | Mirror of `/api/v1/memories` |
| `owui_web` | `search`, `fetch` | Open WebUI's own search engine and URL loader |
| `owui_ask` | — | Blocks on a Pi dialog; Open WebUI renders it as its own `ask_user` prompt |
| `owui_chat` | `current`, `rename` | Finds its own conversation by matching the Pi session id |
| `owui_skill` | `list`, `read`, `create`, `update` | Publishes procedures into Open WebUI's skill library |
| `display_file` | — | Opens a workspace file in Open WebUI's file panel, or `inline: true` |
| `set_tasks` | — | Publishes a live task checklist in the chat |

`display_file` and `set_tasks` need the patches described below; everything else works
against an unpatched instance.

## MCP servers from Open WebUI

Open WebUI keeps MCP servers in its tool-server configuration. The extension reads
`GET /api/v1/configs/tool_servers`, keeps the enabled `type: "mcp"` entries, and registers
them with Pi **while loading**, so they connect with any `mcp.json` servers at session
start. One definition serves both sides and nothing is written to disk.

They get `codemode` exposure: their tools stay out of the prompt and scripts reach them via
`searchTools()`/`describeTool()` as `mcp__<server>__<tool>`. Set `OPEN_WEBUI_MCP=off` to skip
the bridge; a server named in `~/.pi/agent/mcp.json` overrides the registration.

OAuth-backed servers are skipped — their token lives in Open WebUI's OAuth client manager,
so Pi has to authenticate those itself (`pi mcp add`). `/openwebui` lists what was
registered and what was skipped.

## Resources (skills + prompt templates)

On startup the extension materializes Open WebUI skills into
`~/.cache/pi-openwebui/skills/` and hands the directory to Pi through `resources_discover`.
Pi then advertises each skill by name and description and loads `SKILL.md` only when the
task matches. Open WebUI prompt templates become Pi `/commands` the same way.

Trees are copied whole (including `scripts/`), with a `description` frontmatter injected
when Open WebUI keeps it in a column rather than in the file.

## Configuration (environment only)

| Variable | Default | Meaning |
|---|---|---|
| `OPEN_WEBUI_API_KEY` | — | **Required.** A user API key (`sk-…`) |
| `OPEN_WEBUI_BASE_URL` | `http://localhost:3000` | Open WebUI base URL |
| `OPEN_WEBUI_MAX_CHARS` | `12000` | Max characters per read/query result |
| `OPEN_WEBUI_TIMEOUT_MS` | `60000` | Per-request timeout |
| `OPEN_WEBUI_MCP` | `on` | Register Open WebUI's MCP servers with Pi |
| `OPEN_WEBUI_RESOURCES` | `on` | Materialize skills and prompts |
| `OPEN_WEBUI_RESOURCES_TTL_MIN` | `15` | Skill cache lifetime |
| `OPEN_WEBUI_DEBUG` | `off` | Log discovery detail to stderr |

There is deliberately **no key file fallback**: the extension reads the environment, and how
the key reaches the process is a deployment concern. Without a key it registers no tools
and warns once.

## Install

```bash
pi -e /path/to/pi-openwebui          # local checkout
pi install git:github.com/autonomous-toaster/pi-openwebui@v0.1.0
```

Inside an `open-terminal` image, copy the repo in and list it in settings:

```json
{ "extensions": ["/opt/pi-openwebui/extension/index.ts"] }
```

## Patching Open WebUI

Two behaviours only exist for Open WebUI's own chat tools, so agents never had them. Both
patches target `Output.tool()`, the single choke point for agent tool results, and are
idempotent and fail loudly if upstream moves the anchor.

| Patch | Effect |
|---|---|
| `patches/agent_display_file.py` | emits `terminal:display_file`, which opens the file panel |
| `patches/agent_tasks.py` | emits `chat:message:tasks`, which renders a task checklist |

```dockerfile
FROM open-webui:<your-tag>
USER root
COPY pi-openwebui/patches/agent_display_file.py /tmp/
COPY pi-openwebui/patches/agent_tasks.py /tmp/
RUN python3 /tmp/agent_display_file.py /app/backend/open_webui/utils/agents/output.py \
 && python3 /tmp/agent_tasks.py /app/backend/open_webui/utils/agents/output.py \
 && rm -f /tmp/agent_*.py \
 && python3 -m py_compile /app/backend/open_webui/utils/agents/output.py
```

The checklist is live page state, not history: Open WebUI keeps it in the component, so a
reload loses it. Persisting it would need a frontend change too.

## Running inside an open-terminal workspace

```dockerfile
COPY pi-openwebui /opt/pi-openwebui
COPY seed-pi-config.sh /usr/local/bin/seed-pi-config.sh
ENV OPEN_WEBUI_BASE_URL=http://open-webui:8080 \
    PI_CODING_AGENT_DIR=/home/user/.pi/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/seed-pi-config.sh"]
USER user
```

The seed script adds `"extensions": ["/opt/pi-openwebui/extension/index.ts"]` and
`"defaultTools": ["+codemode"]` to `/home/user/.pi/agent/settings.json` (idempotent,
preserves other keys), sources `/home/user/.pi/agent/env` for per-user variables, then
execs the upstream entrypoint.

Three things bite here:

- **`USER user` matters.** Without it the workspace runs as root, `HOME=/root`, and Pi
  reads an ephemeral `/root/.pi/agent` — the seeded settings and any per-user `models.json`
  are silently ignored.
- **`PI_CODING_AGENT_DIR` pins Pi's config** to the bind-mounted home whatever the launch.
- **Local paths go in `extensions`, not `packages`.** `packages` takes `npm:`/`git:` specs;
  an absolute path there is ignored without a warning.

## Acting on the running conversation

`owui_chat` renames the chat the agent is in without being told which one: Open WebUI
stores the Pi session id in every agent message (`meta.agent`, a JWT with a `session_id`
claim), and `ctx.sessionManager.getSessionId()` returns the same value, so the tool matches
it against recent chats. Rename is a title-only `POST /api/v1/chats/{id}`.

`PI_SESSION_ID` is injected into bash commands, not into the extension process — hence the
session manager.

## Tests

Both scripts drive the tool `execute()` functions with a recorder standing in for
`ExtensionAPI`, so they need neither Pi nor a model.

```bash
export OPEN_WEBUI_BASE_URL=http://<host>:3000
export OPEN_WEBUI_API_KEY=$(cat /path/to/key)

node test/smoke.ts     # read paths + resources_discover (OPEN_WEBUI_TEST_WEB=1 adds web)
node test/write.ts     # creates and deletes a throwaway note and memory
```

## API details worth knowing

Each of these cost real debugging time against 0.13.3:

- **Trailing slashes matter.** `/api/v1/skills` is served by the SPA catch-all (HTTP 200,
  HTML); `/api/v1/skills/` hits the router.
- **Skill file contents are raw bytes**, not JSON, and `version_id` is mandatory:
  `GET /api/v1/skills/id/{id}/files/content?path=&version_id=`.
- **Skill list omits `content`**; only `GET /api/v1/skills/id/{id}` includes it.
- **Skills API contracts**: `create` with a file list must include `SKILL.md` at the root;
  `update` with file `operations` is optimistic and needs `expected_version_id`.
- **Knowledge collections are named by the raw knowledge id**, not `knowledge_<id>`.
- **`/knowledge/{id}/files/batch/add` answers 200 when it indexed nothing.** It embeds
  whatever text the upload already extracted, so uploads must use
  `process=true&process_in_background=false`, and duplicate content is rejected silently
  with the same empty result. The tool verifies by re-listing.
- **Notes** carry `data.pages[]`, each with `content.{md,html,json}` and a `revision`. The
  editor falls back to `marked.parse(content.md)` when html/json are absent, so writing
  markdown only is a valid state. `NoteForm` rejects `data.pages` on create.
- **Hybrid search flips the score meaning.** With `ENABLE_RAG_HYBRID_SEARCH` on,
  `query/collection` returns relevance in 0..1 (higher is better); off, it returns cosine
  distance (lower is better). The tool reads the config and labels accordingly.
- **Web search is a chat builtin, not an endpoint.** `/retrieval/process/web/search` is the
  closest HTTP equivalent and embeds loaded pages into a `web-search-<user>-<hash>`
  collection when the bypass flag is off; `/retrieval/process/url?process=false` extracts
  one page with no side effect.
- **`ask_user` is reachable from the Pi side.** Pi's dialogs are a request/response
  sub-protocol and Open WebUI's Pi transport already maps `select`, `input`, `confirm` and
  `editor` onto its `ask_user` UI. A custom Open WebUI tool could not do this: those run in
  the chat pipeline and are never callable from the agent.
- **Epoch units vary** (seconds, ms, ns) across resources.
- **Frontmatter descriptions need quoting**: an unquoted YAML scalar with a colon makes Pi
  drop the skill silently.

## Troubleshooting

- **`cannot reach Open WebUI … Request was cancelled` in a dev shell**: some hosts set
  `HTTP_PROXY`, and Pi's HTTP stack honours it, so LAN traffic gets proxied and stalls.
  Run with `env -u HTTP_PROXY -u HTTPS_PROXY pi …`.
- **No tools at all**: `OPEN_WEBUI_API_KEY` is unset.
- **Skills missing**: `OPEN_WEBUI_DEBUG=on` logs discovery; check
  `~/.cache/pi-openwebui/skills`. A name collision keeps the first skill discovered.

## License

MIT
