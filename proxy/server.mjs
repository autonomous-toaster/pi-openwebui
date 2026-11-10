#!/usr/bin/env node
/**
 * owui-file-proxy — serves workspace files to the browser, authenticated as the user.
 *
 * The browser authenticates with Open WebUI's own session cookie: it is host-scoped, not
 * port-scoped, so a page on `host:3000` sends `token` to `host:3001` as well (same-site,
 * since ports do not participate in site or cookie scope). The proxy therefore verifies
 * that cookie with Open WebUI, learns *who* is asking, and only ever opens files inside
 * that user's own workspace home. No tokens in URLs, no public directory, no expiring
 * links, and incognito gets a 401.
 *
 * Request: GET /f?p=/home/user/out/chart.png
 * Identity: Cookie: token=<Open WebUI session JWT>
 *
 * Layout: the terminals volume is mounted at HOMES_ROOT and each user's workspace home is
 * HOMES_ROOT/HOMES_PREFIX/<user-id>, so the request path is rewritten under that prefix.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const OWUI_URL = (process.env.OWUI_URL || "http://open-webui:8080").replace(/\/+$/, "");
const HOMES_ROOT = resolve(process.env.HOMES_ROOT || "/homes");
const HOMES_PREFIX = (process.env.HOMES_PREFIX || "terminals").replace(/^\/+|\/+$/g, "");
const WORKSPACE_HOME = process.env.WORKSPACE_HOME || "/home/user";
const SESSION_CACHE_S = Number(process.env.SESSION_CACHE_S || 60);

const MIME = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".json": "application/json",
	".html": "text/html; charset=utf-8",
};

/** token -> { userId, expiresAt }; avoids an Open WebUI round trip per image. */
const sessions = new Map();

function cookieToken(req) {
	const header = req.headers.cookie || "";
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === "token") return decodeURIComponent(rest.join("="));
	}
	return "";
}

async function userIdFor(token) {
	const cached = sessions.get(token);
	if (cached && cached.expiresAt > Date.now()) return cached.userId;

	const response = await fetch(`${OWUI_URL}/api/v1/auths/`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) return undefined;

	const body = await response.json().catch(() => undefined);
	const userId = body?.id;
	if (!userId) return undefined;
	sessions.set(token, { userId, expiresAt: Date.now() + SESSION_CACHE_S * 1000 });
	return userId;
}

function deny(res, status, message) {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
	res.end(`${message}\n`);
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url || "/", "http://proxy");
	if (url.pathname !== "/f") return deny(res, 404, "not found");

	const requested = url.searchParams.get("p") || "";
	if (!requested.startsWith(`${WORKSPACE_HOME}/`)) {
		return deny(res, 400, `p must be a path under ${WORKSPACE_HOME}`);
	}

	const token = cookieToken(req);
	if (!token) {
		return deny(res, 401, "not signed in to Open WebUI (no token cookie on this host)");
	}

	let userId;
	try {
		userId = await userIdFor(token);
	} catch {
		return deny(res, 502, "could not verify the session with Open WebUI");
	}
	if (!userId) return deny(res, 401, "Open WebUI rejected this session");

	// Only this user's own workspace home, never another user's and never the volume root.
	const ownHome = resolve(HOMES_ROOT, HOMES_PREFIX, userId);
	const absolute = resolve(ownHome, requested.slice(WORKSPACE_HOME.length + 1));
	if (!absolute.startsWith(ownHome + sep)) return deny(res, 403, "outside your workspace");

	let info;
	try {
		info = statSync(absolute);
	} catch {
		return deny(res, 404, "not found");
	}
	if (!info.isFile()) return deny(res, 404, "not found");

	res.writeHead(200, {
		"Content-Type": MIME[extname(absolute).toLowerCase()] || "application/octet-stream",
		"Content-Length": info.size,
		"Content-Disposition": "inline",
		"Cache-Control": "private, max-age=60",
		"X-Content-Type-Options": "nosniff",
	});
	createReadStream(absolute).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`owui-file-proxy on :${PORT} · owui ${OWUI_URL} · root ${HOMES_ROOT}/${HOMES_PREFIX}`);
});
