/**
 * owui_display — show a workspace file in the Open WebUI chat, without uploading it.
 *
 * Open WebUI serves `/static` from a public, unauthenticated directory. Mounting a
 * per-user directory there turns the workspace filesystem into something the chat can
 * render: the file keeps living in the workspace, OWUI only gets a read-only view of one
 * folder. That is why no upload (`POST /api/v1/files/`) is needed.
 *
 * Files outside that folder are hard-linked into it (same filesystem, no extra bytes),
 * falling back to a copy only when the link cannot cross a filesystem boundary.
 *
 * Requires, on the Open WebUI container:
 *   -v <host>/terminals/<user-id>/shared:/app/backend/open_webui/static/shared:ro
 * and in the agent environment:
 *   OPEN_WEBUI_PUBLIC_URL=http://<host>:3000   (how the *browser* reaches Open WebUI)
 */
import { copyFile, link, mkdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failed, ok } from "./common.ts";

const HOME = "/home/user";
const SHARE_DIR = join(HOME, "shared");

/** Served by /static, so keep names URL-safe. */
const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

/** Images render inline; everything else becomes a link the chat can open. */
const INLINE_IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

interface DisplayParams {
	path?: unknown;
	alt?: unknown;
}

export function registerDisplayTool(pi: ExtensionAPI, options: { publicUrl: string }): void {
	pi.registerTool({
		name: "owui_display",
		label: "Show a file in Open WebUI",
		description:
			"Show a workspace file in the Open WebUI chat as an inline image or a clickable file, without uploading it.",
		promptSnippet: "Show a workspace file (image, PDF, text) inline in the Open WebUI chat",
		promptGuidelines: [
			"Use owui_display after generating an image, chart or report the user should look at; do not paste the same content as text as well.",
			"owui_display takes an absolute path under /home/user.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Absolute path of the file to show, e.g. /home/user/out/chart.png" }),
			alt: Type.Optional(Type.String({ description: "Alt text or link label" })),
		}),

		async execute(_toolCallId, params: DisplayParams) {
			const action = "display";
			try {
				const requested = String(params.path ?? "").trim();
				if (!requested) return ok(action, "Provide `path`.");

				const absolute = resolve(HOME, requested);
				if (!absolute.startsWith(`${HOME}/`)) {
					return ok(action, `Refusing to display ${requested}: it is outside ${HOME}.`);
				}

				try {
					const info = await stat(absolute);
					if (!info.isFile()) return ok(action, `${requested} is not a file.`);
				} catch {
					return ok(action, `${requested} does not exist.`);
				}

				await mkdir(SHARE_DIR, { recursive: true });
				const extension = extname(absolute).toLowerCase();
				const raw = basename(absolute);
				const safe = raw.replace(SAFE_NAME, "-");
				const target = join(SHARE_DIR, safe);

				if (resolve(target) !== absolute) {
					try {
						await link(absolute, target);
					} catch (err) {
						const code = (err as NodeJS.ErrnoException).code;
						if (code === "EEXIST") {
							// Already shared under this name.
						} else {
							await copyFile(absolute, target);
						}
					}
				}

				const base = options.publicUrl.replace(/\/+$/, "");
				const url = `${base}/static/shared/${encodeURIComponent(safe)}`;
				const label = String(params.alt ?? raw);
				const markdown = INLINE_IMAGE.has(extension) ? `![${label}](${url})` : `[${label}](${url})`;

				return ok(
					action,
					`Shown in the chat as ${url}\n\nInclude this markdown in your reply:\n${markdown}`,
				);
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
