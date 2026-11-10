#!/usr/bin/env node
/**
 * owui-file-proxy — serves workspace files to the browser for Open WebUI chats.
 *
 * Why this exists: Open WebUI's file API needs an upload (copies pile up, with no easy
 * cleanup), and mounting a folder under /static is readable by anyone who can reach the
 * port. This service does neither: it only serves paths for which the agent minted a
 * short-lived HMAC signature, and it refuses anything outside the mounted homes root.
 *
 * Request:  GET /f?p=<absolute path>&e=<unix expiry>&s=<hex hmac>
 * Signature: HMAC-SHA256(secret, `${path}\n${expiry}`) — hex
 *
 * The signature covers the path, so a link cannot be edited into another file, and it
 * expires, so a link leaked into a chat log stops working. There is no directory listing
 * and no path the caller did not sign for.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.PROXY_SECRET || "";
const HOMES_ROOT = resolve(process.env.HOMES_ROOT || "/homes");
const MAX_AGE_S = Number(process.env.MAX_AGE_S || 3600);

if (!SECRET) {
	console.error("PROXY_SECRET is required");
	process.exit(1);
}

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

function sign(path, expiry) {
	return createHmac("sha256", SECRET).update(`${path}\n${expiry}`).digest("hex");
}

function signatureMatches(expected, provided) {
	const a = Buffer.from(expected, "hex");
	const b = Buffer.from(provided, "hex");
	return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function deny(res, status, message) {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(`${message}\n`);
}

createServer((req, res) => {
	const url = new URL(req.url || "/", "http://proxy");
	if (url.pathname !== "/f") return deny(res, 404, "not found");

	const path = url.searchParams.get("p") || "";
	const expiry = Number(url.searchParams.get("e") || 0);
	const provided = url.searchParams.get("s") || "";

	if (!path || !provided) return deny(res, 400, "missing p or s");
	if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return deny(res, 410, "link expired");
	if (!signatureMatches(sign(path, expiry), provided)) return deny(res, 403, "bad signature");

	const absolute = resolve(path);
	if (absolute !== HOMES_ROOT && !absolute.startsWith(HOMES_ROOT + sep)) {
		return deny(res, 403, "outside the served root");
	}

	let info;
	try {
		info = statSync(absolute);
	} catch {
		return deny(res, 404, "not found");
	}
	if (!info.isFile()) return deny(res, 404, "not found");

	const type = MIME[extname(absolute).toLowerCase()] || "application/octet-stream";
	res.writeHead(200, {
		"Content-Type": type,
		"Content-Length": info.size,
		"Content-Disposition": "inline",
		"Cache-Control": `private, max-age=${Math.min(300, MAX_AGE_S)}`,
		"X-Content-Type-Options": "nosniff",
	});
	createReadStream(absolute).pipe(res);
}).listen(PORT, "0.0.0.0", () => {
	console.log(`owui-file-proxy listening on :${PORT}, root ${HOMES_ROOT}, links valid ${MAX_AGE_S}s`);
});
