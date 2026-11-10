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
| `OPENWEBUI_API_KEY` | — | **Required.** A user API key (`sk-…`) from Settings → Account → API keys |
| `OPENWEBUI_BASE_URL` | `http://localhost:3000` | Open WebUI base URL |
| `OPENWEBUI_MAX_CHARS` | `12000` | Max characters per read/query result |
| `OPENWEBUI_TIMEOUT_MS` | `60000` | Per-request timeout |
| `OPENWEBUI_RESOURCES` | `on` | Materialize skills/prompts (`off` disables) |
| `OPENWEBUI_RESOURCES_TTL_MIN` | `15` | Cache lifetime before re-fetching skills |
| `OPENWEBUI_DEBUG` | `off` | Log discovery details to stderr |

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

## Tests

Both scripts run without Pi: they hand the extension a recorder that mimics
`ExtensionAPI` and call each tool's `execute()`.

```bash
export OPENWEBUI_BASE_URL=http://192.168.1.18:3000
export OPENWEBUI_API_KEY=$(cat /tmp/owui_test_key)

node test/smoke.ts    # read paths + resources_discover (set OPENWEBUI_TEST_NOTE / _KB for more)
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

## License

MIT
