/**
 * owui_ask — ask the user a question mid-run.
 *
 * No Open WebUI tool is involved: Pi's dialogs are a request/response sub-protocol
 * (`extension_ui_request` / `extension_ui_response`), and Open WebUI's Pi transport
 * (`utils/agents/pi.py`) already maps `select`, `confirm`, `input` and `editor` onto
 * its own `ask_user` UI and returns the answer. So a tool that calls `ctx.ui.*` is
 * enough to reach the person in the chat.
 *
 * Outside an interactive client (CLI `pi -p`, cron), `ctx.hasUI` is false and the tool
 * tells the model to ask in its final message instead of blocking.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failed, ok } from "./common.ts";

interface AskParams {
	question?: unknown;
	options?: unknown;
	allow_freeform?: unknown;
	timeout_ms?: unknown;
}

const MAX_TIMEOUT_MS = 10 * 60_000;

export function registerAskTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "owui_ask",
		label: "Ask the user",
		description:
			"Ask the user a clarifying question and wait for the answer. Use only when the next step depends on a choice you cannot infer safely.",
		promptSnippet: "Ask the user a clarifying question and wait for the answer",
		promptGuidelines: [
			"Use owui_ask instead of guessing when the user's intent or a trade-off is genuinely ambiguous; never use it for permission to act on something they already asked for.",
			"Give owui_ask 2-5 short options when the choice is bounded; omit options only for free-form input.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question, phrased so it can be answered without context" }),
			options: Type.Optional(
				Type.Array(Type.String(), { description: "2-5 short choices; omit for free-form text input" }),
			),
			allow_freeform: Type.Optional(
				Type.Boolean({ description: "With options, also accept a typed answer (Open WebUI shows it automatically)" }),
			),
			timeout_ms: Type.Optional(Type.Number({ description: "Auto-cancel after this many milliseconds" })),
		}),

		async execute(_toolCallId, params: AskParams, _signal, _onUpdate, ctx) {
			const question = String(params.question ?? "").trim();
			if (!question) return ok("ask", "Provide `question`.");

			if (!ctx.hasUI) {
				return ok(
					"ask",
					"No interactive client is attached, so the question cannot be shown. Ask it in your final message instead.",
				);
			}

			const options = (Array.isArray(params.options) ? params.options : [])
				.map((option) => String(option).trim())
				.filter(Boolean);
			const timeout = Math.min(Number(params.timeout_ms) || 120_000, MAX_TIMEOUT_MS);

			try {
				if (options.length >= 2) {
					const choice = await ctx.ui.select(question, options, { timeout });
					if (choice === undefined) return ok("ask", "The user did not answer (cancelled or timed out).");
					return ok("ask", `The user chose: ${choice}`);
				}

				const answer = await ctx.ui.input(question, options[0] ?? "Your answer", { timeout });
				if (answer === undefined) return ok("ask", "The user did not answer (cancelled or timed out).");
				return ok("ask", `The user answered: ${answer}`);
			} catch (err) {
				return failed("ask", err);
			}
		},
	});
}
