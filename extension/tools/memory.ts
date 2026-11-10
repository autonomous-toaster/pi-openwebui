/**
 * owui_memory — read and write Open WebUI memories (the "user memory" store that
 * Open WebUI itself uses for cross-chat recall).
 *
 * Write operations exist because the API exposes them; treat them as opt-in and
 * keep individual memories short and factual.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwuiClient } from "../client.ts";
import type { Config } from "../config.ts";
import { failed, listLines, ok, oneLine } from "./common.ts";

interface Memory {
	id: string;
	content: string;
	type?: unknown;
	path?: string | null;
	updated_at?: number;
}

const ACTIONS = ["list", "search", "add", "update", "delete"] as const;

interface MemoryParams {
	action?: unknown;
	content?: string;
	id?: string;
	query?: string;
	type?: unknown;
	limit?: number;
}

export function registerMemoryTool(pi: ExtensionAPI, client: OwuiClient, _config: Config): void {
	pi.registerTool({
		name: "owui_memory",
		label: "Open WebUI memory",
		description: "List, search, add, update or delete the user's Open WebUI memories.",
		promptSnippet: "Read and write the user's Open WebUI memories",
		promptGuidelines: [
			"Use owui_memory when the user states a durable preference or fact that Open WebUI should remember, or asks what it remembers.",
			"Keep owui_memory entries to one short, atomic fact each.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: "list | search | add | update | delete" }),
			content: Type.Optional(Type.String({ description: "Memory text (for add/update)" })),
			id: Type.Optional(Type.String({ description: "Memory id (for update/delete)" })),
			query: Type.Optional(Type.String({ description: "Search text (for search)" })),
			type: Type.Optional(StringEnum(["user", "context"], { description: "Memory type (default context)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum entries (default 20)" })),
		}),

		async execute(_toolCallId, params: MemoryParams, signal: AbortSignal | undefined) {
			const action = String(params.action ?? "");
			try {
				if (action === "list") {
					const memories = await client.get<Memory[]>("/api/v1/memories/", { signal });
					if (!memories.length) return ok(action, "No memories.");
					const limit = params.limit ?? 50;
					return ok(
						action,
						[
							`${memories.length} memories:`,
							listLines(
								memories.slice(0, limit),
								(memory) => `- ${oneLine(memory.content, 200)} · id=${memory.id}${memory.type ? ` · ${memory.type}` : ""}`,
							),
							memories.length > limit ? `…${memories.length - limit} more (raise limit)` : "",
						]
							.filter(Boolean)
							.join("\n"),
					);
				}

				if (action === "search") {
					const payload = params.query?.trim()
						? await client.post<Memory[]>("/api/v1/memories/search", { query: params.query, limit: params.limit ?? 20 }, { signal })
						: await client.get<Memory[]>("/api/v1/memories/", { signal });
					if (!payload.length) return ok(action, "No memories matched.");
					return ok(
						action,
						listLines(payload, (memory) => `- ${oneLine(memory.content, 200)} · id=${memory.id}`),
					);
				}

				if (action === "add") {
					if (!params.content?.trim()) return ok(action, "Provide `content` to add.");
					const memory = await client.post<Memory>(
						"/api/v1/memories/add",
						{ content: params.content.trim(), type: params.type === "user" ? "user" : "context" },
						{ signal },
					);
					return ok(action, `Added memory · id=${memory?.id ?? "?"}`);
				}

				if (action === "update") {
					if (!params.id) return ok(action, "Provide `id` to update.");
					if (!params.content?.trim()) return ok(action, "Provide `content` for the new memory text.");
					await client.post(
						`/api/v1/memories/${params.id}/update`,
						{ content: params.content.trim(), ...(params.type === "user" || params.type === "context" ? { type: params.type } : {}) },
						{ signal },
					);
					return ok(action, `Updated memory ${params.id}`);
				}

				if (action === "delete") {
					if (!params.id) return ok(action, "Provide `id` to delete.");
					await client.delete(`/api/v1/memories/${params.id}`, { signal });
					return ok(action, `Deleted memory ${params.id}`);
				}

				return ok(action, `Unknown action "${action}".`);
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
