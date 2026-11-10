# owui-file-proxy

Serves workspace files to the browser for Open WebUI chats: no upload, no public
directory, and no token in the URL — the browser's Open WebUI session decides who may read
what.

```sh
docker run -d --name owui-file-proxy --network openwebui --restart unless-stopped \
  -e OWUI_URL=http://open-webui:8080 \
  -e HOMES_ROOT=/homes -e HOMES_PREFIX=terminals \
  -v terminals-data:/homes:ro \
  -p 3001:8080 \
  owui-file-proxy:latest
```

Agent environment: `OPEN_WEBUI_FILE_PROXY_URL=http://<host>:3001`.

## Why the cookie works across ports

Open WebUI sets `token` as a host-scoped cookie (`Secure=false`, `SameSite=Lax`, no
`Domain`, no port). Cookies ignore ports, and "same-site" is scheme + registrable domain,
so a page served from `http://host:3000` sends that cookie to `http://host:3001` on an
`<img>` request. The proxy then asks Open WebUI who the token belongs to
(`GET /api/v1/auths/`) and serves **only** files under that user's own workspace home.

Consequences worth knowing:

- An incognito window has no cookie and gets **401**.
- The URL alone is worthless; there is nothing to leak in a chat log or a screenshot.
- The link only works when the browser reaches the proxy on the **same host** it uses for
  Open WebUI. Different hostnames mean a different cookie jar.
- Behind HTTPS the cookie is still `Secure=false` here, so an `http://` proxy keeps
  working; if you later force `WEBUI_AUTH_COOKIE_SECURE`, the proxy needs TLS too.

## Endpoint

`GET /f?p=/home/user/<path>` — the only route. `400` if the path is outside `/home/user`,
`401` without a valid session, `403` if the resolved file escapes the caller's home,
`404` if it is missing.
