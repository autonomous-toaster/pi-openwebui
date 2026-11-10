/**
 * Write-path test: creates a throwaway note and memory through the tools, verifies
 * them, then removes both. Requires a live instance and a user API key.
 *
 *   OPEN_WEBUI_BASE_URL=… OPEN_WEBUI_API_KEY=… node test/write.ts
 */
import piOpenWebUI from "../extension/index.ts";
import { OwuiClient } from "../extension/client.ts";
import { loadConfig } from "../extension/config.ts";

type RegisteredTool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ text: string }>; details: unknown; isError?: boolean }>;
};

const tools = new Map<string, RegisteredTool>();
const fakePi = {
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
	},
	registerCommand() {},
	on() {},
};

const config = loadConfig();
if (!config.apiKey) {
	console.error("OPEN_WEBUI_API_KEY is not set");
	process.exit(2);
}
const client = new OwuiClient(config);

piOpenWebUI(fakePi as never);

async function call(tool: string, params: Record<string, unknown>) {
	const definition = tools.get(tool);
	if (!definition) throw new Error(`${tool} not registered`);
	const result = await definition.execute("test", params);
	const text = result.content.map((part) => part.text).join("\n");
	console.log(`\n${result.isError ? "✗" : "✓"} ${tool} ${params.action}\n  ${text.split("\n").join("\n  ")}`);
	if (result.isError) throw new Error(`${tool} ${params.action} failed`);
	return text;
}

const marker = `pi-openwebui test ${new Date().toISOString()}`;
let noteId = "";
let memoryId = "";

try {
	const created = await call("owui_notes", { action: "create", title: marker, content: "line one" });
	noteId = /id=([0-9a-f-]{36})/.exec(created)?.[1] ?? "";
	if (!noteId) throw new Error("could not parse note id");

	await call("owui_notes", { action: "append", id: noteId, content: "line two" });
	const read = await call("owui_notes", { action: "read", id: noteId });
	if (!read.includes("line two")) throw new Error("append not visible on read");
	if (!/rev=\d+/.test(read)) throw new Error("revision not reported");

	const added = await call("owui_memory", { action: "add", content: `${marker} memory`, type: "context" });
	memoryId = /id=([0-9a-f-]{36})/.exec(added)?.[1] ?? "";
	await call("owui_memory", { action: "update", id: memoryId, content: `${marker} memory (updated)` });
	const found = await call("owui_memory", { action: "search", query: "pi-openwebui test" });
	if (!found.includes(memoryId)) throw new Error("memory not found after update");

	console.log("\n✓ write paths OK");
} finally {
	if (noteId) {
		await client.delete(`/api/v1/notes/${noteId}/delete`).catch((err) => console.error("note cleanup failed:", err));
		console.log(`\ncleanup: note ${noteId} deleted`);
	}
	if (memoryId) {
		await client.delete(`/api/v1/memories/${memoryId}`).catch((err) => console.error("memory cleanup failed:", err));
		console.log(`cleanup: memory ${memoryId} deleted`);
	}
}
