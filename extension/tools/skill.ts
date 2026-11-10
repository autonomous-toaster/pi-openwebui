/**
 * owui_skill — publish and maintain Open WebUI skills.
 *
 * The extension already loads skills *from* Open WebUI into Pi (`resources.ts`). This closes
 * the loop: a procedure the agent worked out can become a workspace skill that both the
 * agent and Open WebUI chats then see.
 *
 * Skills are directory trees (SKILL.md plus optional files); Open WebUI addresses them by a
 * slug id and stores name/description in columns, not in frontmatter.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwuiClient } from "../client.ts";
import { failed, listLines, ok, oneLine } from "./common.ts";

interface SkillSummary {
	id: string;
	name: string;
	description?: string;
	is_active?: boolean;
}

interface SkillDetail extends SkillSummary {
	content?: string;
	version_id?: string;
}

interface SkillFileOp {
	op: "put";
	path: string;
	content: string;
}

const ACTIONS = ["list", "read", "create", "update"] as const;

interface SkillParams {
	action?: unknown;
	id?: unknown;
	name?: unknown;
	description?: unknown;
	content?: unknown;
	files?: unknown;
	commit_message?: unknown;
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function fileOps(raw: unknown): SkillFileOp[] {
	if (!Array.isArray(raw)) return [];
	const ops: SkillFileOp[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const path = String(record.path ?? "").trim().replace(/^\/+/, "");
		if (!path || path.includes("..")) continue;
		ops.push({ op: "put", path, content: String(record.content ?? "") });
	}
	return ops;
}

export function registerSkillTool(pi: ExtensionAPI, client: OwuiClient): void {
	pi.registerTool({
		name: "owui_skill",
		label: "Open WebUI skills",
		description:
			"List, read, create or update Open WebUI skills — the reusable procedures Open WebUI advertises to chats and this agent loads at startup.",
		promptSnippet: "Publish or update a reusable procedure as an Open WebUI skill",
		promptGuidelines: [
			"Use owui_skill create when the user asks to save a procedure for reuse, and update when an existing skill is out of date.",
			"Write the skill body as Markdown instructions in `content`; put supporting files in `files` as {path, content} with relative paths.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: "list | read | create | update" }),
			id: Type.Optional(Type.String({ description: "Skill id (slug); defaults to a slug of `name`" })),
			name: Type.Optional(Type.String({ description: "Skill name (for create)" })),
			description: Type.Optional(Type.String({ description: "When to use it — the routing hint" })),
			content: Type.Optional(Type.String({ description: "Markdown body of SKILL.md" })),
			files: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({ description: "Relative path, e.g. scripts/run.sh" }),
						content: Type.String({ description: "File text" }),
					}),
					{ description: "Supporting files (optional)" },
				),
			),
			commit_message: Type.Optional(Type.String({ description: "History entry for an update" })),
		}),

		async execute(_toolCallId, params: SkillParams, signal) {
			const action = String(params.action ?? "");
			try {
				if (action === "list") {
					const skills = (await client.get<SkillSummary[]>("/api/v1/skills/", { signal })).filter(
						(skill) => skill.is_active !== false,
					);
					if (!skills.length) return ok(action, "No skills.");
					return ok(
						action,
						listLines(
							skills,
							(skill) => `- ${oneLine(skill.name, 60)} · id=${skill.id} · ${oneLine(skill.description ?? "", 90)}`,
						),
					);
				}

				if (action === "read") {
					const id = String(params.id ?? "").trim();
					if (!id) return ok(action, "Provide `id` (see owui_skill list).");
					const skill = await client.get<SkillDetail>(`/api/v1/skills/id/${id}`, { signal });
					return ok(
						action,
						`# ${skill.name} · id=${skill.id}\n${skill.description ?? ""}\n\n${skill.content ?? ""}`.trim(),
					);
				}

				if (action === "create") {
					const name = String(params.name ?? "").trim();
					if (!name) return ok(action, "Provide `name` for the new skill.");
					const id = slug(String(params.id ?? name)) || slug(name);
					const description = String(params.description ?? "").trim();
					if (!description) return ok(action, "Provide `description`: it decides when the skill is used.");

					await client.post(
						"/api/v1/skills/create",
						{
							id,
							name,
							description,
							content: String(params.content ?? ""),
							...(fileOps(params.files).length ? { files: fileOps(params.files).map(({ path, content }) => ({ path, content })) } : {}),
						},
						{ signal },
					);
					return ok(action, `Created skill ${id}. It appears in Pi after the next /reload or session start.`);
				}

				if (action === "update") {
					const id = String(params.id ?? "").trim();
					if (!id) return ok(action, "Provide `id` to update.");
					const ops = fileOps(params.files);
					const body: Record<string, unknown> = {
						id,
						name: String(params.name ?? id),
						...(String(params.description ?? "").trim() ? { description: String(params.description).trim() } : {}),
						...(typeof params.content === "string" ? { content: params.content } : {}),
						...(ops.length ? { operations: ops } : {}),
						...(String(params.commit_message ?? "").trim()
							? { commit_message: String(params.commit_message).trim() }
							: {}),
					};
					await client.post(`/api/v1/skills/id/${id}/update`, body, { signal });
					return ok(action, `Updated skill ${id}.`);
				}

				return ok(action, `Unknown action "${action}".`);
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
