# owui-file-proxy

Serves workspace files to the browser for Open WebUI chats, without uploading them and
without a public directory.

```sh
docker run -d --name owui-file-proxy --network openwebui --restart unless-stopped \
  -e PROXY_SECRET="$(openssl rand -hex 32)" \
  -e HOMES_ROOT=/homes \
  -v terminals-data:/homes:ro \
  -p 3001:8080 \
  owui-file-proxy:latest
```

Then in the agent environment:

```sh
OPEN_WEBUI_FILE_PROXY_URL=http://<host>:3001
OPEN_WEBUI_FILE_PROXY_SECRET=<the same PROXY_SECRET>
```

## Why a signature and not a cookie

Open WebUI authenticates browsers with a `token` cookie scoped to its own origin. An
`<img>` in the chat points at this proxy, which is a different origin, so the cookie is not
sent. The agent therefore mints a link:

```
/f?p=<absolute path>&e=<expiry>&s=HMAC-SHA256(secret, "path\nexpiry")
```

Properties: unguessable, expiring (default 1 h), bound to one exact path, read-only, and
confined to `HOMES_ROOT` after resolution. No listing, no traversal, no unsigned read.

## Endpoints

`GET /f?p=&e=&s=` — the only route. Returns the file inline, or `400`/`403`/`404`/`410`.
