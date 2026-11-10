import type { Config } from "../config.ts";
import type { OwuiClient } from "../client.ts";
import { clip, oneLine, timestamp, withHint } from "../text.ts";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: { action: string; ok: boolean; error?: string };
	isError?: boolean;
}

export function ok(action: string, text: string): ToolResult {
	return { content: [{ type: "text", text }], details: { action, ok: true } };
}

export function failed(action: string, err: unknown): ToolResult {
	const message = err instanceof Error ? err.message : String(err);
	return {
		content: [{ type: "text", text: `Open WebUI ${action} failed: ${message}` }],
		details: { action, ok: false, error: message },
		isError: true,
	};
}

export interface ReadArgs {
	offset?: number;
	limit?: number;
}

export function clipText(text: string, args: ReadArgs, cfg: Config, noun: string): string {
	return withHint(clip(text, args.offset ?? 0, args.limit ?? cfg.maxChars), noun);
}

export function listLines<T>(items: T[], render: (item: T) => string): string {
	return items.map(render).join("\n");
}

export { oneLine, timestamp };
