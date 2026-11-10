# pi-openwebui

A Pi extension that exposes Open WebUI to the Pi coding agent: **notes**, **knowledge
bases**, **memories**, and Open WebUI **skills / prompt templates** loaded as native Pi
resources.

Built for [Open WebUI](https://github.com/open-webui/open-webui) ≥ 0.13, where coding
agents run inside an `open-terminal` workspace and only receive a prompt — no tools, no
RAG, no skills. This extension closes that gap from the agent side.

## Tools

| Tool | Actions | Notes |
|---|---|---|
| `owui_notes` | `list`, `search`, `read`, `create`, `append` | Reads are sliced (`offset`/`limit`); append passes the page revision so a concurrent browser edit returns 409 instead of being clobbered |
| `owui_knowledge` | `list`, `files`, `search`, `read`, `query` | `search` is free SQL `LIKE`; `query` is vector retrieval and costs one embedding call |
| `owui_memory` | `list`, `search`, `add`, `update`, `delete` | Read/write, mirroring the `/api/v1/memories` surface |
| `owui_web` | `search`, `fetch` | Open WebUI's own search engine and URL loader, through `/api/v1/retrieval/*` |
| `owui_ask` | — | Blocks on a Pi dialog; Open WebUI renders it as its own `ask_user` prompt |

## Resources (skills + prompt templates)

On startup the extension materializes Open WebUI skills into `~/.cache/pi-openwebui/skills/`
and hands the directory to Pi through the documented `resources_discover` event. Pi then
advertises each skill by name/description (lazy: `SKILL.md` is only read when the task
matches) and supports `/skill:<name>`. Open WebUI prompt templates become Pi `/commands`
via the same mechanism.

Skill trees are copied whole — `SKILL.md`, `reference.md`, `scripts/*.py`, … — with a
`description` frontmatter added when Open WebUI stores it in a column rather than in the
file (its SKILL.md files usually have no frontmatter).

## Configuration (environment only)

| Variable | Default | Meaning |
|---|---|---|
| `OPEN_WEBUI_API_KEY` | — | **Required.** A user API key (`sk-…`) from Settings → Account → API keys |
| `OPEN_WEBUI_BASE_URL` | `http://localhost:3000` | Open WebUI base URL |
| `OPEN_WEBUI_MAX_CHARS` | `12000` | Max characters per read/query result |
| `OPEN_WEBUI_TIMEOUT_MS` | `60000` | Per-request timeout |
| `OPEN_WEBUI_RESOURCES` | `on` | Materialize skills/prompts (`off` disables) |
| `OPEN_WEBUI_RESOURCES_TTL_MIN` | `15` | Cache lifetime before re-fetching skills |
| `OPEN_WEBUI_DEBUG` | `off` | Log discovery details to stderr |

There is deliberately **no key file fallback**: the extension reads the environment, and
how the key reaches the process is a deployment concern. Without a key it registers no
tools and warns once.

## Install

Local checkout (what this repo is tested with):

```bash
pi -e /path/to/pi-openwebui
```

As a package:

```bash
pi install git:github.com/autonomous-toaster/pi-openwebui@v0.1.0
```

Inside an `open-terminal` image, copy the repo in and either add `-e /path/to/repo` to the
Pi arguments or list it in `~/.pi/agent/settings.json`:

```json
{ "packages": ["/opt/pi-openwebui"] }
```

## Running inside an open-terminal workspace

The image used by the agent container bakes the package at `/opt/pi-openwebui` and seeds
the per-user config on start:

```dockerfile
COPY pi-openwebui /opt/pi-openwebui
COPY seed-pi-config.sh /usr/local/bin/seed-pi-config.sh
ENV OPEN_WEBUI_BASE_URL=http://open-webui:8080 \
    PI_CODING_AGENT_DIR=/home/user/.pi/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/seed-pi-config.sh"]
USER user
```

`seed-pi-config.sh` adds `"extensions": ["/opt/pi-openwebui/extension/index.ts"]` to
`/home/user/.pi/agent/settings.json` (idempotent, preserves other keys) and then execs the
upstream entrypoint.

Three things bite here:

- **`USER user` matters.** Without it the workspace runs as root, `HOME=/root`, and Pi
  reads `/root/.pi/agent` — an ephemeral directory, so the seeded settings and any
  per-user `models.json` are silently ignored.
- **`PI_CODING_AGENT_DIR` pins Pi's config** to the bind-mounted home regardless of how
  the container is launched.
- **Local paths go in `extensions`, not `packages`.** `packages` takes `npm:`/`git:`
  specs; an absolute path there is ignored without any warning.

The API key is not baked in: Terminals policy env is per *instance*, not per user, so a
static key there would make every user's agent act as one account. How the per-user key
reaches the process is a deployment decision (see the note at the top of `config.ts`).

## Tests

Both scripts run without Pi: they hand the extension a recorder that mimics
`ExtensionAPI` and call each tool's `execute()`.

```bash
export OPEN_WEBUI_BASE_URL=http://192.168.1.18:3000
export OPEN_WEBUI_API_KEY=$(cat /tmp/owui_test_key)

node test/smoke.ts    # read paths + resources_discover (set OPEN_WEBUI_TEST_NOTE / _KB for more)
node test/write.ts    # creates and deletes a throwaway note + memory
```

Verified against Open WebUI 0.13.3: 3 tools, 6–7 skills materialized (one collided with a
host skill and was correctly shadowed), semantic retrieval, note create/append, memory
add/update/delete.

## API details worth knowing

Discovered while building against 0.13.3 — each of these is a real trap:

- **Trailing slashes matter.** `/api/v1/skills` is served by the SPA catch-all (HTTP 200,
  HTML); `/api/v1/skills/` hits the router.
- **Skill file contents are raw bytes**, not JSON: `GET /api/v1/skills/id/{id}/files/content?path=&version_id=`
  returns the file itself with its own media type, and `version_id` is mandatory.
- **Skill list omits `content`**; only `GET /api/v1/skills/id/{id}` includes it.
- **Knowledge vector collections are named by the raw knowledge id**, not `knowledge_<id>`.
- **Notes** carry `data.pages[]`, each with `content.{md,html,json}` and a `revision`; the
  editor falls back to `marked.parse(content.md)` when html/json are absent, so writing
  markdown only is a valid state. `NoteForm` rejects `data.pages` on create.
- **Epoch units vary** (seconds, ms, ns) across resources — `updated_at` handling must
  normalise.
- **Frontmatter descriptions need quoting**: an unquoted YAML scalar with a colon makes Pi
  drop the skill silently.
- **Hybrid search flips the score meaning.** With `ENABLE_RAG_HYBRID_SEARCH` on,
  `query/collection` returns relevance scores in 0..1 (higher is better); with it off it
  returns cosine distances (lower is better). `owui_knowledge query` reads
  `/api/v1/retrieval/config` once and labels the number accordingly.
- **Web search is a chat builtin, not an endpoint.** `/api/v1/retrieval/process/web/search`
  is the closest HTTP equivalent: it uses the same engine and permission checks, and with
  `BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL` off it embeds the loaded pages into a
  `web-search-<user>-<hash>` collection (one embedding call per distinct query).
  `/api/v1/retrieval/process/url?process=false` extracts a single page with no side effect.
- **`ask_user` is reachable after all, from the Pi side.** Pi's dialogs are a
  request/response sub-protocol (`extension_ui_request` / `extension_ui_response`), and
  Open WebUI's Pi transport (`utils/agents/pi.py`) already maps `select`, `input`,
  `confirm` and `editor` onto its `ask_user` UI. So `owui_ask` needs no Open WebUI
  change — but a *custom Open WebUI tool* could not do it: those run in Open WebUI's chat
  pipeline and are never callable from the terminal agent.
- **`display_file` stays out of reach**: Pi has no "show this file" UI method, and Open
  WebUI resolves terminal files against the rendered chat. Uploading the file with
  `/api/v1/files/` and returning a link is the workable substitute, if ever needed.

## Troubleshooting

- **`cannot reach Open WebUI … Request was cancelled` in a dev shell**: some hosts set
  `HTTP_PROXY`, and Pi's HTTP stack honours it, so LAN traffic gets proxied and stalls.
  Run with `env -u HTTP_PROXY -u HTTPS_PROXY pi …`. Agent workspaces have no proxy.
- **No tools at all**: `OPEN_WEBUI_API_KEY` is unset — Pi warns once and registers nothing.
- **Skills missing**: `OPEN_WEBUI_DEBUG=on` logs discovery; check `~/.cache/pi-openwebui/skills`
  and remember a name collision keeps the first skill discovered.

## License

MIT
