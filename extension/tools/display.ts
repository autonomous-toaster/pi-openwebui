/**
 * display_file — open a workspace file in the Open WebUI side panel.
 *
 * This is Open WebUI's own mechanism, not a workaround: the backend emits
 * `terminal:display_file` and the frontend opens its file panel, fetching the bytes from
 * the terminal server with the token it already holds. No upload, no proxy, no public
 * directory, and nothing to authenticate that Open WebUI does not already authenticate.
 *
 * The backend only emitted that event for chat tool-server calls, so `patches/` teaches the
 * agent output to emit it too. The tool returns the same shape open-terminal's
 * `display_file` endpoint returns, which is what that code reads.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failed, ok } from "./common.ts";

const HOME = "/home/user";

interface DisplayParams {
	path?: unknown;
	page?: unknown;
}

export function registerDisplayTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "display_file",
		label: "Show a file to the user",
		description:
			"Open a workspace file in the user's Open WebUI file panel so they can look at it. Does not return the content.",
		promptSnippet: "Open a workspace file in the user's file panel",
		promptGuidelines: [
			"Use display_file once per deliverable you created or updated (image, PDF, report), then do not repeat its content as text.",
			"display_file takes an absolute path under /home/user and is for the user's eyes, not for reading the file yourself.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Absolute path of the file to show, e.g. /home/user/out/chart.png" }),
			page: Type.Optional(Type.Number({ description: "For PDF/DOCX/PPTX, the 1-based page to open" })),
		}),

		async execute(_toolCallId, params: DisplayParams) {
			const action = "display_file";
			try {
				const requested = String(params.path ?? "").trim();
				if (!requested) return ok(action, "Provide `path`.");

				const absolute = resolve(HOME, requested);
				if (!absolute.startsWith(`${HOME}/`)) {
					return ok(action, `Refusing to display ${requested}: it is outside ${HOME}.`);
				}

				const info = await stat(absolute).catch(() => undefined);
				if (!info?.isFile()) {
					// The event is only emitted for files that exist, so say so instead of
					// returning a path the panel would fail to open.
					return ok(action, `${requested} does not exist.`);
				}

				// Shape expected by the backend when it emits terminal:display_file.
				const payload = {
					path: absolute,
					exists: true,
					displayed: true,
					...(typeof params.page === "number" ? { page: params.page } : {}),
				};
				return {
					content: [{ type: "text", text: `Opened ${absolute} in the file panel.` }],
					details: { action, ok: true, path: absolute },
					structuredContent: payload,
				};
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
