/**
 * owui_display — show a workspace file in the Open WebUI chat, authenticated.
 *
 * The file is uploaded to Open WebUI (`POST /api/v1/files/?process=false`) and referenced
 * by a **relative** URL, `/api/v1/files/<id>/content`. That endpoint requires the user,
 * and the browser authenticates with its `token` cookie, so the link works for the person
 * in the chat and for nobody else. Files inherit Open WebUI's own access control; there is
 * no public directory involved.
 *
 * Cost of that choice: Open WebUI keeps a copy. The alternative — serving the workspace
 * directory through `/static` — needs no copy but is world-readable to anyone who can
 * reach the port, which is why it is not done here.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwuiClient } from "../client.ts";
import { failed, ok } from "./common.ts";

const HOME = "/home/user";

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".md": "text/markdown",
	".txt": "text/plain",
	".csv": "text/csv",
	".json": "application/json",
	".html": "text/html",
};

const INLINE_IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);

interface UploadedFile {
	id: string;
	filename?: string;
	meta?: { name?: string };
}

interface DisplayParams {
	path?: unknown;
	alt?: unknown;
}

export function registerDisplayTool(pi: ExtensionAPI, client: OwuiClient): void {
	pi.registerTool({
		name: "owui_display",
		label: "Show a file in Open WebUI",
		description:
			"Show a workspace file in the Open WebUI chat as an inline image or a link. The file is attached to the user's Open WebUI files, visible only to them.",
		promptSnippet: "Show a workspace file (image, PDF, text) in the Open WebUI chat",
		promptGuidelines: [
			"Use owui_display after generating an image, chart or report the user should look at; do not paste the same content as text as well.",
			"owui_display takes an absolute path under /home/user and returns the markdown to include in your reply.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Absolute path of the file to show, e.g. /home/user/out/chart.png" }),
			alt: Type.Optional(Type.String({ description: "Alt text or link label" })),
		}),

		async execute(_toolCallId, params: DisplayParams, signal) {
			const action = "display";
			try {
				const requested = String(params.path ?? "").trim();
				if (!requested) return ok(action, "Provide `path`.");

				const absolute = resolve(HOME, requested);
				if (!absolute.startsWith(`${HOME}/`)) {
					return ok(action, `Refusing to display ${requested}: it is outside ${HOME}.`);
				}

				const info = await stat(absolute).catch(() => undefined);
				if (!info?.isFile()) return ok(action, `${requested} is not a file.`);

				const extension = extname(absolute).toLowerCase();
				const name = basename(absolute);
				const bytes = await readFile(absolute);
				const type = MIME_TYPES[extension] ?? "application/octet-stream";

				const form = new FormData();
				form.append("file", new Blob([bytes], { type }), name);

				const uploaded = await client.postForm<UploadedFile>(
					"/api/v1/files/",
					form,
					{ query: { process: false }, signal, timeoutMs: 120_000 },
				);
				if (!uploaded?.id) return ok(action, `Open WebUI did not return a file id for ${requested}.`);

				// Relative on purpose: the browser sends its session cookie, so the link is
				// authenticated and independent of how the user reaches Open WebUI.
				const url = `/api/v1/files/${uploaded.id}/content`;
				const label = String(params.alt ?? name);
				const markdown = INLINE_IMAGE.has(extension) ? `![${label}](${url})` : `[${label}](${url})`;

				return ok(
					action,
					`Attached as Open WebUI file ${uploaded.id} (${Math.round(bytes.length / 1024)} KB).\n\nInclude this markdown in your reply:\n${markdown}`,
				);
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
