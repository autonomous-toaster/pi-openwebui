/**
 * owui_notes — read and write Open WebUI notes.
 *
 * Notes are page trees; each page carries `content.{md,html,json}` plus a revision.
 * Open WebUI's editor falls back to `marked.parse(content.md)` when html/json are
 * absent (NoteEditor.svelte), so writing markdown only is a supported state, not a
 * half-write. Writes pass the page revision so a concurrent browser edit wins with
 * a 409 instead of being clobbered.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwuiClient } from "../client.ts";
import type { Config } from "../config.ts";
import { clipText, failed, listLines, ok, oneLine, timestamp } from "./common.ts";

interface NotePage {
	id: string;
	title?: string;
	content?: { md?: string };
	revision?: number;
}

interface NoteSummary {
	id: string;
	title: string;
	is_pinned?: boolean;
	updated_at?: number;
	created_at?: number;
}

interface Note extends NoteSummary {
	data?: { pages?: NotePage[]; content?: { md?: string } };
	write_access?: boolean;
}

const ACTIONS = ["list", "search", "read", "create", "append"] as const;

interface NotesParams {
	action?: unknown;
	id?: string;
	query?: string;
	title?: string;
	content?: string;
	page?: string;
	offset?: number;
	limit?: number;
}

function pickPage(note: Note, pageId?: string): { page?: NotePage; md: string } {
	const pages = note.data?.pages ?? [];
	const page =
		pages.find((entry) => entry.id === pageId) ??
		pages.find((entry) => entry.id === "main") ??
		pages[0];
	return { page, md: page?.content?.md ?? note.data?.content?.md ?? "" };
}

export function registerNotesTool(pi: ExtensionAPI, client: OwuiClient, config: Config): void {
	pi.registerTool({
		name: "owui_notes",
		label: "Open WebUI notes",
		description:
			"Read and write the user's Open WebUI notes (markdown pages). Long notes are returned in slices.",
		promptSnippet: "List, search, read, create or append to Open WebUI notes",
		promptGuidelines: [
			"Use owui_notes when the user refers to their Open WebUI notes or asks to save findings into one.",
			"owui_notes read returns a next offset when the page is truncated; call it again with that offset instead of asking for the whole note.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description: "list | search | read | create | append",
			}),
			id: Type.Optional(Type.String({ description: "Note id (for read/append)" })),
			query: Type.Optional(Type.String({ description: "Search text (for search)" })),
			title: Type.Optional(Type.String({ description: "Note title (for create)" })),
			content: Type.Optional(
				Type.String({ description: "Markdown to write: note body for create, appended text for append" }),
			),
			page: Type.Optional(Type.String({ description: "Page id within the note (default: main)" })),
			offset: Type.Optional(Type.Number({ description: "Character offset to start reading from" })),
			limit: Type.Optional(Type.Number({ description: "Maximum characters to return" })),
		}),

		async execute(_toolCallId, params: NotesParams, signal: AbortSignal | undefined) {
			const action = String(params.action ?? "");
			try {
				if (action === "list") {
					const notes = await client.get<NoteSummary[]>("/api/v1/notes/", { signal });
					if (!notes.length) return ok(action, "No notes.");
					return ok(
						action,
						listLines(notes, (note) =>
							[
								`- ${oneLine(note.title, 100)}`,
								`id=${note.id}`,
								note.is_pinned ? "pinned" : "",
								`updated=${timestamp(note.updated_at)}`,
							]
								.filter(Boolean)
								.join(" · "),
						),
					);
				}

				if (action === "search") {
					if (!params.query?.trim()) return ok(action, "Provide `query` to search notes.");
					const notes = await client.get<NoteSummary[]>("/api/v1/notes/search", {
						query: { query: params.query },
						signal,
					});
					if (!notes.length) return ok(action, `No notes matched "${params.query}".`);
					return ok(
						action,
						listLines(notes, (note) => `- ${oneLine(note.title, 100)} · id=${note.id}`),
					);
				}

				if (action === "read") {
					if (!params.id) return ok(action, "Provide `id` (see owui_notes list).");
					const note = await client.get<Note>(`/api/v1/notes/${params.id}`, { signal });
					const { page, md } = pickPage(note, params.page);
					const pages = (note.data?.pages ?? []).map((entry) => entry.id);
					const header = [
						`# ${note.title}`,
						`id=${note.id}`,
						`page=${page?.id ?? "main"}${page?.revision !== undefined ? ` rev=${page.revision}` : ""}`,
						pages.length > 1 ? `pages=${pages.join(",")}` : "",
						`${md.length} chars`,
					]
						.filter(Boolean)
						.join(" · ");
					return ok(action, `${header}\n\n${clipText(md, params, config, "note")}`);
				}

				if (action === "create") {
					if (!params.title?.trim()) return ok(action, "Provide `title` for a new note.");
					const note = await client.post<Note>(
						"/api/v1/notes/create",
						{ title: params.title, data: { content: { md: params.content ?? "" } } },
						{ signal },
					);
					return ok(action, `Created note "${note.title}" · id=${note.id}`);
				}

				if (action === "append") {
					if (!params.id) return ok(action, "Provide `id` to append to.");
					if (!params.content?.trim()) return ok(action, "Provide `content` to append.");
					const note = await client.get<Note>(`/api/v1/notes/${params.id}`, { signal });
					const { page, md } = pickPage(note, params.page);
					const merged = `${md.trimEnd()}\n\n${params.content.trim()}\n`;
					await client.post(
						`/api/v1/notes/${params.id}/update`,
						{
							data: { content: { md: merged } },
							page_id: page?.id ?? "main",
							...(page?.revision === undefined ? {} : { page_revision: page.revision }),
						},
						{ signal },
					);
					return ok(
						action,
						`Appended ${params.content.trim().length} chars to "${note.title}" (page ${page?.id ?? "main"}, now ${merged.length} chars)`,
					);
				}

				return ok(action, `Unknown action "${action}".`);
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
