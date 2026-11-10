/**
 * MCP bridge — Open WebUI is the source of truth for MCP servers, Pi is the client.
 *
 * Open WebUI keeps MCP servers in its tool-server configuration (`type: "mcp"`), reachable
 * with a user key at `GET /api/v1/configs/tool_servers`. Pi accepts servers registered
 * while an extension loads, and connects them together with the ones from `mcp.json`.
 *
 * So the same server definition serves Open WebUI chats and the terminal agent, with no
 * second configuration file and nothing written to disk. Registrations are per session,
 * which is exactly what the API allows.
 *
 * Limit worth knowing: OAuth-backed servers keep their token inside Open WebUI's OAuth
 * client manager, so they are skipped here. Pi authenticates MCP servers on its own
 * (`pi mcp`), and a server listed in `mcp.json` overrides a registration with the same
 * name, so either can win.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OwuiClient } from "./client.ts";
import type { Config } from "./config.ts";

interface ToolServerConnection {
	url?: string;
	type?: string;
	auth_type?: string;
	headers?: Record<string, string> | null;
	key?: string;
	config?: { enable?: boolean } | null;
	info?: { name?: string; description?: string; id?: string } | null;
}

export interface McpSyncResult {
	registered: string[];
	skipped: string[];
}

function slug(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return cleaned || "mcp";
}

export async function syncMcpServers(
	pi: ExtensionAPI,
	client: OwuiClient,
	config: Config,
): Promise<McpSyncResult> {
	const result: McpSyncResult = { registered: [], skipped: [] };
	if (!config.mcp) return result;

	let connections: ToolServerConnection[] = [];
	try {
		const payload = await client.get<{ TOOL_SERVER_CONNECTIONS?: ToolServerConnection[] }>(
			"/api/v1/configs/tool_servers",
			{ timeoutMs: 5000 },
		);
		connections = payload?.TOOL_SERVER_CONNECTIONS ?? [];
	} catch {
		// Open WebUI unreachable at load time: no servers, never a failed startup.
		return result;
	}

	for (const connection of connections) {
		if (connection.type !== "mcp" || !connection.url) continue;
		if (connection.config?.enable === false) continue;

		const label = connection.info?.description || connection.info?.name || new URL(connection.url).hostname;
		const headers: Record<string, string> = { ...(connection.headers ?? {}) };
		if (connection.auth_type === "bearer" && connection.key) {
			headers.Authorization = `Bearer ${connection.key}`;
		}
		if (connection.auth_type?.startsWith("oauth") && !Object.keys(headers).length) {
			// The token lives inside Open WebUI; Pi cannot reuse it without a login of its own.
			result.skipped.push(`${label} (OAuth, authenticate in Pi with: pi mcp add)`);
			continue;
		}

		const name = slug(label);
		try {
			pi.registerMcpServer(name, {
				url: connection.url,
				...(Object.keys(headers).length ? { headers } : {}),
				description: label,
				// codemode keeps big tool sets out of the prompt; scripts reach them by name.
				exposure: "codemode",
				timeout: 60,
			});
			result.registered.push(`${name} (${label})`);
		} catch (err) {
			result.skipped.push(`${label} (${err instanceof Error ? err.message : String(err)})`);
		}
	}

	if (config.debug && (result.registered.length || result.skipped.length)) {
		console.error(`[pi-openwebui] mcp registered: ${result.registered.join(", ") || "none"}`);
	}
	return result;
}
