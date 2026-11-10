/**
 * owui_knowledge — browse and search Open WebUI knowledge bases.
 *
 * Two search modes, deliberately separate because they cost very differently:
 *  - `search` is SQL LIKE over filenames/content (`/knowledge/search/files`) — free.
 *  - `query` is vector retrieval (`/retrieval/query/collection`) — one embedding call.
 *
 * A knowledge base's vector collection is named with the raw knowledge id, not
 * `knowledge_<id>`, so `query` maps ids straight to collection names.
 *
 * The agent can also build collections itself: upload workspace files and index them. That
 * costs embeddings, which is why it is a separate, explicit action.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Type } from "typebox";
import type { OwuiClient } from "../client.ts";
import type { Config } from "../config.ts";
import { clipText, failed, listLines, ok, oneLine } from "./common.ts";

interface KnowledgeBase {
	id: string;
	name: string;
	description?: string;
	file_count?: number;
}

interface KnowledgeFile {
	id: string;
	filename: string;
	meta?: { name?: string };
}

interface FilePage {
	items: KnowledgeFile[];
	total?: number;
}

interface RetrievalResult {
	documents?: string[][];
	metadatas?: Array<Array<Record<string, unknown>>>;
	distances?: number[][];
}

const ACTIONS = ["list", "files", "search", "read", "query", "create", "add", "remove", "delete"] as const;
const HOME = "/home/user";

/**
 * Hybrid search returns relevance scores (higher is better); plain vector search
 * returns cosine distances (lower is better). Label accordingly so the model does not
 * read a good match as a bad one.
 */
async function scoreLabel(client: OwuiClient): Promise<string> {
	try {
		const cfg = await client.get<{ ENABLE_RAG_HYBRID_SEARCH?: boolean }>("/api/v1/retrieval/config");
		return cfg?.ENABLE_RAG_HYBRID_SEARCH ? "score" : "distance";
	} catch {
		return "score";
	}
}

interface KnowledgeParams {
	action?: unknown;
	kb?: string;
	filename?: string;
	file_id?: string;
	query?: string;
	name?: string;
	description?: string;
	paths?: unknown;
	confirm_name?: string;
	k?: number;
	page?: number;
	offset?: number;
	limit?: number;
}

function baseList(payload: KnowledgeBase[] | { items?: KnowledgeBase[] }): KnowledgeBase[] {
	return Array.isArray(payload) ? payload : (payload.items ?? []);
}

function fileList(payload: KnowledgeFile[] | FilePage): KnowledgeFile[] {
	return Array.isArray(payload) ? payload : (payload.items ?? []);
}

export function registerKnowledgeTool(pi: ExtensionAPI, client: OwuiClient, config: Config): void {
	pi.registerTool({
		name: "owui_knowledge",
		label: "Open WebUI knowledge",
		description:
			"Browse Open WebUI knowledge bases: list bases, list or search their files, read a file's extracted text, or run semantic retrieval.",
		promptSnippet: "List, search and read Open WebUI knowledge bases",
		promptGuidelines: [
			"Use owui_knowledge search before owui_knowledge query: search is free, query costs an embedding call.",
			"owui_knowledge read returns extracted text in slices; reuse the returned offset to continue.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description: "list | files | search | read | query | create | add | remove | delete",
			}),
			kb: Type.Optional(Type.String({ description: "Knowledge base id (for files/read/query)" })),
			filename: Type.Optional(Type.String({ description: "File name inside the knowledge base (for read)" })),
			file_id: Type.Optional(Type.String({ description: "File id (for read)" })),
			query: Type.Optional(Type.String({ description: "Search text (for search) or question (for query)" })),
			k: Type.Optional(Type.Number({ description: "Number of chunks for semantic query (default 5)" })),
			name: Type.Optional(Type.String({ description: "Knowledge base name (for create)" })),
			description: Type.Optional(Type.String({ description: "What the base is for (for create)" })),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Workspace files to index (for add), e.g. /home/user/notes/a.md — costs embeddings",
				}),
			),
			confirm_name: Type.Optional(
				Type.String({ description: "For delete: repeat the knowledge base name to confirm" }),
			),
			page: Type.Optional(Type.Number({ description: "Page number for file listings (default 1)" })),
			offset: Type.Optional(Type.Number({ description: "Character offset to start reading from" })),
			limit: Type.Optional(Type.Number({ description: "Maximum characters to return" })),
		}),

		async execute(_toolCallId, params: KnowledgeParams, signal: AbortSignal | undefined) {
			const action = String(params.action ?? "");
			try {
				if (action === "list") {
					const bases = baseList(await client.get<KnowledgeBase[] | { items: KnowledgeBase[] }>(
						"/api/v1/knowledge/",
						{ signal },
					));
					if (!bases.length) return ok(action, "No knowledge bases.");
					return ok(
						action,
						listLines(
							bases,
							(base) =>
								`- ${oneLine(base.name, 80)} · id=${base.id} · ${base.file_count ?? 0} files${base.description ? ` · ${oneLine(base.description, 80)}` : ""}`,
						),
					);
				}

				if (action === "files") {
					if (!params.kb) return ok(action, "Provide `kb` (see owui_knowledge list).");
					const payload = await client.get<KnowledgeFile[] | FilePage>(`/api/v1/knowledge/${params.kb}/files`, {
						query: { page: params.page ?? 1 },
						signal,
					});
					const files = fileList(payload);
					if (!files.length) return ok(action, "No files on this page.");
					const total = Array.isArray(payload) ? files.length : (payload.total ?? files.length);
					return ok(
						action,
						[
							`${files.length} of ${total} files (page ${params.page ?? 1}):`,
							listLines(files, (file) => `- ${oneLine(file.filename, 100)} · id=${file.id}`),
						].join("\n"),
					);
				}

				if (action === "search") {
					if (!params.query?.trim()) return ok(action, "Provide `query` to search files.");
					const payload = await client.get<KnowledgeFile[] | FilePage>("/api/v1/knowledge/search/files", {
						query: { query: params.query, page: params.page ?? 1 },
						signal,
					});
					const files = fileList(payload);
					if (!files.length) return ok(action, `No knowledge files matched "${params.query}".`);
					return ok(
						action,
						listLines(
							files,
							(file) =>
								`- ${oneLine(file.filename, 100)} · id=${file.id}${file.meta?.name && file.meta.name !== file.filename ? ` · ${oneLine(file.meta.name, 80)}` : ""}`,
						),
					);
				}

				if (action === "read") {
					let fileId = params.file_id;
					if (!fileId) {
						if (!params.kb || !params.filename) {
							return ok(action, "Provide `file_id`, or `kb` + `filename`.");
						}
						const payload = await client.get<KnowledgeFile[] | FilePage>(
							`/api/v1/knowledge/${params.kb}/files`,
							{ query: { page: params.page ?? 1 }, signal },
						);
						const wanted = params.filename.toLowerCase();
						const match = fileList(payload).find(
							(file) =>
								file.filename.toLowerCase() === wanted ||
								(file.meta?.name ?? "").toLowerCase() === wanted ||
								file.filename.toLowerCase().includes(wanted),
						);
						if (!match) return ok(action, `No file matching "${params.filename}" on page ${params.page ?? 1}.`);
						fileId = match.id;
					}
					const payload = await client.get<{ content?: string }>(`/api/v1/files/${fileId}/data/content`, {
						signal,
					});
					const text = payload?.content ?? "";
					if (!text) return ok(action, `File ${fileId} has no extracted text (not processed yet?).`);
					return ok(action, clipText(text, params, config, "file"));
				}

				if (action === "query") {
					if (!params.query?.trim()) return ok(action, "Provide `query` (the question to retrieve for).");
					let collections: string[];
					if (params.kb) {
						collections = [params.kb];
					} else {
						const bases = baseList(await client.get<KnowledgeBase[] | { items: KnowledgeBase[] }>(
							"/api/v1/knowledge/",
							{ signal },
						));
						collections = bases.map((base) => base.id);
					}
					if (!collections.length) return ok(action, "No knowledge bases to query.");
					const result = await client.post<RetrievalResult>(
						"/api/v1/retrieval/query/collection",
						{ collection_names: collections, query: params.query, k: params.k ?? 5 },
						{ signal },
					);
					const documents = result?.documents?.[0] ?? [];
					const metadatas = result?.metadatas?.[0] ?? [];
					const distances = result?.distances?.[0] ?? [];
					if (!documents.length) {
						return ok(action, `No chunks retrieved for "${params.query}" (collections: ${collections.join(",")}).`);
					}
					const label = await scoreLabel(client);
					const budgetPerChunk = Math.max(500, Math.floor(config.maxChars / documents.length));
					const blocks = documents.map((doc, index) => {
						const meta = metadatas[index] ?? {};
						const source = String(meta.name ?? meta.file_id ?? "?");
						const distance = distances[index];
						const score = typeof distance === "number" ? ` ${label}=${distance.toFixed(3)}` : "";
						const body = doc.length > budgetPerChunk ? `${doc.slice(0, budgetPerChunk)}…` : doc;
						return `--- ${source}${score}\n${body}`;
					});
					return ok(action, blocks.join("\n\n"));
				}

				if (action === "create") {
					const name = String(params.name ?? "").trim();
					if (!name) return ok(action, "Provide `name` for the new knowledge base.");
					const created = await client.post<KnowledgeBase>(
						"/api/v1/knowledge/create",
						{ name, description: String(params.description ?? "") },
						{ signal },
					);
					if (!created?.id) return ok(action, `Open WebUI did not return an id for "${name}".`);
					return ok(action, `Created knowledge base "${created.name ?? name}" · id=${created.id}`);
				}

				if (action === "add") {
					if (!params.kb) return ok(action, "Provide `kb` to add files to.");
					const paths = (Array.isArray(params.paths) ? params.paths : []).map(String).filter(Boolean);
					if (!paths.length) return ok(action, "Provide `paths` to index.");

					// Upload first, then add in one batch so the base is indexed once.
					const fileIds: string[] = [];
					const skipped: string[] = [];
					for (const rawPath of paths) {
						const absolute = resolve(HOME, rawPath);
						if (!absolute.startsWith(`${HOME}/`)) {
							skipped.push(`${rawPath} (outside ${HOME})`);
							continue;
						}
						let bytes: Buffer;
						try {
							bytes = await readFile(absolute);
						} catch {
							skipped.push(`${rawPath} (not readable)`);
							continue;
						}
						const form = new FormData();
						form.append("file", new Blob([bytes]), basename(absolute));
						const uploaded = await client.postForm<{ id?: string }>(
							"/api/v1/files/",
							form,
							{ query: { process: false }, signal, timeoutMs: 120_000 },
						);
						if (uploaded?.id) fileIds.push(uploaded.id);
						else skipped.push(`${rawPath} (upload failed)`);
					}
					if (!fileIds.length) {
						return ok(action, `Nothing indexed.${skipped.length ? `\nSkipped: ${skipped.join(", ")}` : ""}`);
					}

					await client.post(
						`/api/v1/knowledge/${params.kb}/files/batch/add`,
						fileIds.map((fileId) => ({ file_id: fileId })),
						{ signal, timeoutMs: 300_000 },
					);

					return ok(
						action,
						[
							`Added ${fileIds.length} file(s) to knowledge base ${params.kb}: ${fileIds.map((id) => id.slice(0, 8)).join(", ")}`,
							"Open WebUI indexes them in the background; they are searchable once embedding finishes.",
							skipped.length ? `Skipped: ${skipped.join(", ")}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					);
				}

				if (action === "remove") {
					if (!params.kb) return ok(action, "Provide `kb`.");
					const fileId = String(params.file_id ?? "").trim();
					if (!fileId) return ok(action, "Provide `file_id` (see owui_knowledge files).");
					await client.post(
						`/api/v1/knowledge/${params.kb}/file/remove`,
						{ file_id: fileId },
						{ signal },
					);
					return ok(action, `Removed file ${fileId} from ${params.kb}.`);
				}

				if (action === "delete") {
					if (!params.kb) return ok(action, "Provide `kb` to delete.");
					const confirmName = String(params.confirm_name ?? "").trim();
					const bases = baseList(
						await client.get<KnowledgeBase[] | { items: KnowledgeBase[] }>("/api/v1/knowledge/", { signal }),
					);
					const target = bases.find((base) => base.id === params.kb);
					if (!target) return ok(action, `No knowledge base with id ${params.kb}.`);
					if (!confirmName || confirmName !== target.name) {
						return ok(
							action,
							`Refusing to delete "${target.name}". Pass confirm_name="${target.name}" to confirm; this also drops its ${target.file_count ?? 0} files from the index.`,
						);
					}
					await client.delete(`/api/v1/knowledge/${params.kb}/delete`, { signal });
					return ok(action, `Deleted knowledge base "${target.name}" (${params.kb}).`);
				}

				return ok(action, `Unknown action "${action}".`);
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
