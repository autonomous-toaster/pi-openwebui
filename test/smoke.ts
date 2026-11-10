/**
 * Live smoke tests for the Open WebUI extension, without running Pi.
 *
 * The extension only needs an object shaped like ExtensionAPI (registerTool,
 * on, registerCommand), so we hand it a recorder and call each tool's execute()
 * directly. Point it at a real instance:
 *
 *   OPEN_WEBUI_BASE_URL=http://192.168.1.18:3000 \
 *   OPEN_WEBUI_API_KEY=$(cat /tmp/owui_test_key) \
 *   node test/smoke.ts
 *
 * Optional: OPEN_WEBUI_TEST_NOTE (note id), OPEN_WEBUI_TEST_KB (knowledge id).
 */
import piOpenWebUI from "../extension/index.ts";

type RegisteredTool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: Array<{ text: string }>; details: unknown; isError?: boolean }>;
};

const tools = new Map<string, RegisteredTool>();
const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();

const fakePi = {
	registerTool(tool: RegisteredTool) {
		tools.set(tool.name, tool);
	},
	registerCommand() {},
	on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
		handlers.set(event, handler);
	},
};

let failures = 0;

function show(label: string, result: { content: Array<{ text: string }>; isError?: boolean }) {
	const text = result.content.map((part) => part.text).join("\n");
	const head = text.split("\n").slice(0, 8).join("\n");
	const more = text.split("\n").length > 8 ? "\n  …" : "";
	console.log(`\n${result.isError ? "✗" : "✓"} ${label}${result.isError ? " (error)" : ""}\n  ${head.replace(/\n/g, "\n  ")}${more}`);
	if (result.isError) failures += 1;
}

async function call(tool: string, params: Record<string, unknown>) {
	const definition = tools.get(tool);
	if (!definition) throw new Error(`tool ${tool} not registered (missing OPEN_WEBUI_API_KEY?)`);
	return definition.execute(`test-${Date.now()}`, params);
}

async function main() {
	piOpenWebUI(fakePi as never);
	console.log(`tools registered: ${[...tools.keys()].join(", ") || "none"}`);

	if (!process.env.OPEN_WEBUI_API_KEY) {
		console.log("OPEN_WEBUI_API_KEY not set — skipping live calls");
		return;
	}

	show("notes list", await call("owui_notes", { action: "list" }));
	show("notes search", await call("owui_notes", { action: "search", query: "impot" }));

	const noteId = process.env.OPEN_WEBUI_TEST_NOTE;
	if (noteId) {
		show("notes read (head)", await call("owui_notes", { action: "read", id: noteId, limit: 400 }));
		show("notes read (offset)", await call("owui_notes", { action: "read", id: noteId, offset: 400, limit: 200 }));
	}

	show("knowledge list", await call("owui_knowledge", { action: "list" }));
	show("knowledge search", await call("owui_knowledge", { action: "search", query: "pajemploi" }));

	const kb = process.env.OPEN_WEBUI_TEST_KB;
	if (kb) {
		show("knowledge files", await call("owui_knowledge", { action: "files", kb }));
		show("knowledge query", await call("owui_knowledge", { action: "query", kb, query: "ACRE taux", k: 2 }));
	}

	show("memory list", await call("owui_memory", { action: "list", limit: 5 }));

	const discover = handlers.get("resources_discover");
	if (discover) {
		const resources = (await discover({ cwd: process.cwd(), reason: "startup" }, { hasUI: false })) as {
			skillPaths?: string[];
			promptPaths?: string[];
		};
		console.log(`\n✓ resources_discover\n  skillPaths: ${JSON.stringify(resources.skillPaths)}`);
		console.log(`  promptPaths: ${JSON.stringify(resources.promptPaths)}`);
	}

	console.log(failures ? `\n${failures} failure(s)` : "\nall good");
	process.exitCode = failures ? 1 : 0;
}

await main();
