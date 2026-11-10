/**
 * Configuration, read from the environment only.
 *
 * OPEN_WEBUI_API_KEY is required. There is deliberately no file fallback: how the
 * key reaches the process is a deployment concern, not the extension's.
 */
export interface Config {
	baseUrl: string;
	apiKey: string;
	/** Maximum characters returned by a single read/query call. */
	maxChars: number;
	timeoutMs: number;
	/** Signed-URL file proxy used by owui_display (empty = feature disabled). */
	fileProxyUrl: string;
	fileProxySecret: string;
	/** Materialize Open WebUI skills/prompts into Pi resource paths. */
	resources: boolean;
	resourcesTtlMs: number;
	debug: boolean;
}

const DEFAULT_BASE_URL = "http://localhost:3000";

function positiveNumber(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isOn(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined || raw === "") return fallback;
	return !["off", "false", "0", "no"].includes(raw.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	return {
		baseUrl: (env.OPEN_WEBUI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
		apiKey: (env.OPEN_WEBUI_API_KEY || "").trim(),
		maxChars: positiveNumber(env.OPEN_WEBUI_MAX_CHARS, 12000),
		timeoutMs: positiveNumber(env.OPEN_WEBUI_TIMEOUT_MS, 60000),
		fileProxyUrl: (env.OPEN_WEBUI_FILE_PROXY_URL || "").replace(/\/+$/, ""),
		fileProxySecret: (env.OPEN_WEBUI_FILE_PROXY_SECRET || "").trim(),
		resources: isOn(env.OPEN_WEBUI_RESOURCES, true),
		resourcesTtlMs: positiveNumber(env.OPEN_WEBUI_RESOURCES_TTL_MIN, 15) * 60_000,
		debug: isOn(env.OPEN_WEBUI_DEBUG, false),
	};
}

export const CONFIG_HELP =
	"OPEN_WEBUI_API_KEY is not set. Create a key in Open WebUI (Settings > Account > API keys) and export it, e.g. OPEN_WEBUI_API_KEY=sk-… . Optionally set OPEN_WEBUI_BASE_URL (default http://localhost:3000).";
