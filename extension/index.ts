/**
 * pi-openwebui — expose Open WebUI to the Pi coding agent.
 *
 * Tools: owui_notes, owui_knowledge, owui_memory, owui_web.
 * Resources: Open WebUI skills and prompt templates appear as Pi skills/prompts.
 *
 * Configuration is environment-only: OPEN_WEBUI_API_KEY (required),
 * OPEN_WEBUI_BASE_URL, OPEN_WEBUI_MAX_CHARS, OPEN_WEBUI_TIMEOUT_MS,
 * OPEN_WEBUI_RESOURCES, OPEN_WEBUI_RESOURCES_TTL_MIN, OPEN_WEBUI_DEBUG.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OwuiClient } from "./client.ts";
import { CONFIG_HELP, loadConfig } from "./config.ts";
import { discoverResources } from "./resources.ts";
import { registerKnowledgeTool } from "./tools/knowledge.ts";
import { registerMemoryTool } from "./tools/memory.ts";
import { registerNotesTool } from "./tools/notes.ts";
import { registerWebTool } from "./tools/web.ts";

export default function piOpenWebUI(pi: ExtensionAPI) {
	const config = loadConfig();

	if (!config.apiKey) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(CONFIG_HELP, "warning");
		});
		return;
	}

	const client = new OwuiClient(config);
	const log = (message: string, level: "info" | "warning" = "info") => {
		if (config.debug) console.error(`[pi-openwebui] ${message}`);
		void level;
	};

	registerNotesTool(pi, client, config);
	registerKnowledgeTool(pi, client, config);
	registerMemoryTool(pi, client, config);
	registerWebTool(pi, client, config);

	pi.on("resources_discover", async (_event, ctx) => {
		const resources = await discoverResources(client, config, (message, level = "info") => {
			if (ctx.hasUI) ctx.ui.notify(message, level);
			else log(message, level);
		});
		return resources;
	});

	pi.registerCommand("openwebui", {
		description: "Show Open WebUI connection status for this session",
		handler: async (_args, ctx) => {
			const lines: string[] = [`Open WebUI: ${config.baseUrl}`];
			try {
				const [notes, bases, skills] = await Promise.all([
					client.get<unknown[]>("/api/v1/notes/"),
					client.get<{ items?: unknown[] } | unknown[]>("/api/v1/knowledge/"),
					client.get<unknown[]>("/api/v1/skills/"),
				]);
				const count = (value: unknown) => (Array.isArray(value) ? value.length : (value as { items?: unknown[] })?.items?.length ?? 0);
				lines.push(
					`connected · ${count(notes)} notes · ${count(bases)} knowledge bases · ${count(skills)} skills`,
				);
				lines.push(
				`tools: owui_notes, owui_knowledge, owui_memory, owui_web · resources: ${config.resources ? "on" : "off"}`,
			);
			} catch (err) {
				lines.push(`not connected: ${err instanceof Error ? err.message : String(err)}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
