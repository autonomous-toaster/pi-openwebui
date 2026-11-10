/**
 * Materialize Open WebUI skills and prompt templates into Pi resource paths.
 *
 * Pi advertises skills by name+description and loads SKILL.md on demand, and it
 * accepts extra paths via the documented `resources_discover` event — so this is a
 * supported integration point, not a workaround. Open WebUI skills are already
 * directory trees (name, description, content, data.files[]), which maps 1:1 onto
 * the Agent Skills layout Pi scans.
 *
 * Cache: ~/.cache/pi-openwebui/{skills,prompts}, refreshed atomically when the
 * stamp is older than OPEN_WEBUI_RESOURCES_TTL_MIN.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import type { OwuiClient } from "./client.ts";
import type { Config } from "./config.ts";

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

interface SkillFileEntry {
	path: string;
	size?: number;
	encoding?: string | null;
}

interface SkillFileList {
	version_id?: string;
	files?: SkillFileEntry[];
}

interface PromptSummary {
	command: string;
	name?: string;
	content?: string;
}

export interface DiscoveredResources {
	skillPaths?: string[];
	promptPaths?: string[];
}

const CACHE_ROOT = join(homedir(), ".cache", "pi-openwebui");
const SKILLS_DIR = join(CACHE_ROOT, "skills");
const PROMPTS_DIR = join(CACHE_ROOT, "prompts");
const STAMP = join(CACHE_ROOT, ".stamp");

function slugify(value: string, fallback: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || fallback;
}

/** Rejects directory traversal in server-provided paths. */
function safeJoin(root: string, relative: string): string | undefined {
	const target = resolve(root, normalize(relative).replace(/^([./\\])+/, ""));
	return target.startsWith(resolve(root) + "/") ? target : undefined;
}

async function freshEnough(ttlMs: number): Promise<boolean> {
	try {
		const info = await stat(STAMP);
		return Date.now() - info.mtimeMs < ttlMs;
	} catch {
		return false;
	}
}

async function fetchSkillFiles(
	client: OwuiClient,
	skill: SkillDetail,
): Promise<{ files: Map<string, Uint8Array>; manifestPaths: string[] }> {
	const files = new Map<string, Uint8Array>();
	const manifestPaths: string[] = [];
	const manifest = await client
		.get<SkillFileList>(`/api/v1/skills/id/${skill.id}/files`)
		.catch(() => undefined);
	const versionId = manifest?.version_id ?? skill.version_id;
	for (const entry of manifest?.files ?? []) {
		if (!entry?.path) continue;
		manifestPaths.push(entry.path);
		const body = await client
			.getBytes(`/api/v1/skills/id/${skill.id}/files/content`, {
				query: { path: entry.path, version_id: versionId },
			})
			.catch(() => undefined);
		if (!body) continue;
		files.set(entry.path, body.bytes);
	}
	return { files, manifestPaths };
}

/** JSON string literals are valid YAML double-quoted scalars, so colons and quotes survive. */
function yamlString(value: string): string {
	return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

function frontmatterFor(skill: SkillDetail): string {
	return [
		"---",
		`name: ${yamlString(slugify(skill.name, skill.id))}`,
		`description: ${yamlString(skill.description ?? skill.name)}`,
		"---",
		"",
	].join("\n");
}

/**
 * Pi only loads a SKILL.md that declares a description, and Open WebUI stores name
 * and description in columns (its SKILL.md files usually carry no frontmatter).
 * So guarantee one, without duplicating an existing block.
 */
function ensureFrontmatter(text: string, skill: SkillDetail): string {
	const body = text.replace(/^\uFEFF/, "");
	if (!body.startsWith("---")) return `${frontmatterFor(skill)}${body}`;
	const end = body.indexOf("\n---", 3);
	if (end === -1) return `${frontmatterFor(skill)}${body}`;
	const block = body.slice(0, end);
	if (/^description:/m.test(block)) return body;
	return `${block}\ndescription: ${yamlString(skill.description ?? skill.name)}${body.slice(end)}`;
}

async function writeSkillTree(client: OwuiClient, skill: SkillDetail, target: string): Promise<number> {
	const { files } = await fetchSkillFiles(client, skill);
	let written = 0;
	for (const [path, bytes] of files) {
		const destination = safeJoin(target, path);
		if (!destination) continue;
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(
			destination,
			path === "SKILL.md" ? ensureFrontmatter(new TextDecoder().decode(bytes), skill) : bytes,
		);
		written += 1;
	}

	// SKILL.md is normally part of the tree; synthesize only if the server omitted it.
	if (!files.has("SKILL.md")) {
		await writeFile(join(target, "SKILL.md"), `${frontmatterFor(skill)}${skill.content ?? ""}`, "utf8");
		written += 1;
	}
	return written;
}

async function refreshSkills(client: OwuiClient, config: Config): Promise<string | undefined> {
	const skills = (await client.get<SkillSummary[]>("/api/v1/skills/")).filter(
		(skill) => skill.is_active !== false,
	);
	const staging = `${SKILLS_DIR}.tmp`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });

	const used = new Set<string>();
	let written = 0;
	for (const summary of skills) {
		const detail = await client
			.get<SkillDetail>(`/api/v1/skills/id/${summary.id}`)
			.catch(() => undefined);
		if (!detail) continue;
		const base = slugify(detail.name ?? summary.name, summary.id);
		const slug = used.has(base) ? `${base}-${summary.id.slice(0, 6)}` : base;
		used.add(slug);
		const target = join(staging, slug);
		await mkdir(target, { recursive: true });
		try {
			written += await writeSkillTree(client, { ...summary, ...detail }, target);
		} catch (err) {
			if (config.debug) console.error(`[pi-openwebui] skill ${summary.name} failed:`, err);
		}
	}

	await rm(SKILLS_DIR, { recursive: true, force: true });
	await rename(staging, SKILLS_DIR);
	if (config.debug) console.error(`[pi-openwebui] materialized ${skills.length} skills (${written} files)`);
	return skills.length ? SKILLS_DIR : undefined;
}

async function refreshPrompts(client: OwuiClient, config: Config): Promise<string | undefined> {
	const prompts = await client.get<PromptSummary[]>("/api/v1/prompts/");
	if (!Array.isArray(prompts) || !prompts.length) return undefined;

	const staging = `${PROMPTS_DIR}.tmp`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });

	let written = 0;
	for (const prompt of prompts) {
		const command = slugify(prompt.command ?? "", "");
		if (!command || typeof prompt.content !== "string") continue;
		const description = yamlString(prompt.name ?? command);
		await writeFile(
			join(staging, `${command}.md`),
			["---", `description: ${description}`, "---", prompt.content].join("\n"),
			"utf8",
		);
		written += 1;
	}
	await rm(PROMPTS_DIR, { recursive: true, force: true });
	await rename(staging, PROMPTS_DIR);
	if (config.debug) console.error(`[pi-openwebui] materialized ${written} prompt templates`);
	return written ? PROMPTS_DIR : undefined;
}

export async function discoverResources(
	client: OwuiClient,
	config: Config,
	log: (message: string, level?: "info" | "warning") => void,
): Promise<DiscoveredResources> {
	if (!config.resources) return {};
	try {
		if (await freshEnough(config.resourcesTtlMs)) {
			const skills = await stat(SKILLS_DIR).then(
				() => SKILLS_DIR,
				() => undefined,
			);
			const prompts = await stat(PROMPTS_DIR).then(
				() => PROMPTS_DIR,
				() => undefined,
			);
			return { skillPaths: skills ? [skills] : undefined, promptPaths: prompts ? [prompts] : undefined };
		}
	} catch {
		// Fall through to a refresh.
	}

	try {
		const [skillPaths, promptPaths] = await Promise.all([
			refreshSkills(client, config).catch((err) => {
				log(`Open WebUI skills unavailable: ${err instanceof Error ? err.message : String(err)}`, "warning");
				return undefined;
			}),
			refreshPrompts(client, config).catch(() => undefined),
		]);
		await writeFile(STAMP, new Date().toISOString(), "utf8").catch(() => undefined);
		return { skillPaths: skillPaths ? [skillPaths] : undefined, promptPaths: promptPaths ? [promptPaths] : undefined };
	} catch (err) {
		log(`Open WebUI resource discovery failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return {};
	}
}

/** Exposed for tests. */
export const paths = { CACHE_ROOT, SKILLS_DIR, PROMPTS_DIR, STAMP };

export async function readStamp(): Promise<string | undefined> {
	return readFile(STAMP, "utf8").catch(() => undefined);
}
