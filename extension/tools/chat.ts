/**
 * owui_chat — act on the Open WebUI conversation the agent is running in.
 *
 * The agent is never told its chat id, but it does not need to be: Open WebUI stores
 * the Pi session id in each agent message (`meta.agent`, a JWT whose `session_id` claim
 * is the same value Pi exposes as `PI_SESSION_ID`). So the chat is found by asking
 * Open WebUI for the user's recent chats and matching that claim.
 *
 * Rename is `POST /api/v1/chats/{id}` with `{"chat": {"title": ...}}`, which Open WebUI
 * accepts as a title-only update.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwuiClient } from "../client.ts";
import { failed, ok } from "./common.ts";

interface ChatSummary {
	id: string;
	title?: string;
	updated_at?: number;
}

interface ChatDetail {
	id: string;
	title?: string;
	chat?: { history?: { messages?: Record<string, { meta?: { agent?: string } }> } };
}

interface AgentClaims {
	session_id?: string;
	chat?: string;
}

const ACTIONS = ["current", "rename"] as const;
const MAX_CHATS_TO_SCAN = 8;

interface ChatParams {
	action?: unknown;
	title?: unknown;
	chat_id?: unknown;
}

/** Reads the claims of the agent JWT Open WebUI stores on the message. No verification needed. */
function agentClaims(token: string): AgentClaims | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
		return JSON.parse(json) as AgentClaims;
	} catch {
		return undefined;
	}
}

function chatHasSession(chat: ChatDetail, sessionId: string): boolean {
	const messages = chat.chat?.history?.messages ?? {};
	for (const message of Object.values(messages)) {
		const token = message?.meta?.agent;
		if (typeof token === "string" && agentClaims(token)?.session_id === sessionId) return true;
	}
	return false;
}

async function resolveChat(client: OwuiClient, sessionId: string, explicit?: string): Promise<string | undefined> {
	if (explicit) return explicit;
	const chats = await client.get<ChatSummary[] | { items?: ChatSummary[] }>("/api/v1/chats/", {
		query: { page: 1 },
	});
	const candidates = Array.isArray(chats) ? chats : (chats.items ?? []);
	for (const candidate of candidates.slice(0, MAX_CHATS_TO_SCAN)) {
		const detail = await client.get<ChatDetail>(`/api/v1/chats/${candidate.id}`);
		if (chatHasSession(detail, sessionId)) return candidate.id;
	}
	return undefined;
}

export function registerChatTool(pi: ExtensionAPI, client: OwuiClient): void {
	pi.registerTool({
		name: "owui_chat",
		label: "Open WebUI chat",
		description:
			"Read or rename the Open WebUI conversation this agent is running in (its title shows in the sidebar).",
		promptSnippet: "Rename the current Open WebUI conversation",
		promptGuidelines: [
			"Use owui_chat rename only when the conversation title is misleading; keep it under 60 characters and describe the topic, not the exchange.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, { description: "current | rename" }),
			title: Type.Optional(Type.String({ description: "New conversation title (for rename)" })),
			chat_id: Type.Optional(Type.String({ description: "Explicit chat id if auto-detection fails" })),
		}),

		async execute(_toolCallId, params: ChatParams, signal, _onUpdate, ctx) {
			const action = String(params.action ?? "");
			try {
				// PI_SESSION_ID is injected into bash commands, not into this process, so
				// read it from the session manager instead.
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				if (!sessionId && !params.chat_id) {
					return ok(action, "No Pi session id is available, so the conversation cannot be identified. Pass `chat_id` explicitly.");
				}

				const chatId = await resolveChat(
					client,
					sessionId,
					params.chat_id ? String(params.chat_id) : undefined,
				);
				if (!chatId) {
					return ok(
						action,
						"Could not match this session to an Open WebUI chat (it may be a local Pi session). Pass `chat_id` explicitly.",
					);
				}

				if (action === "current") {
					const chat = await client.get<ChatDetail>(`/api/v1/chats/${chatId}`, { signal });
					return ok(action, `chat_id=${chatId}\ntitle: ${chat.title ?? "(untitled)"}`);
				}

				if (action === "rename") {
					const title = String(params.title ?? "").trim();
					if (!title) return ok(action, "Provide `title`.");
					if (title.length > 120) return ok(action, "Keep `title` under 120 characters.");
					await client.post(`/api/v1/chats/${chatId}`, { chat: { title } }, { signal });
					return ok(action, `Renamed conversation ${chatId} to "${title}".`);
				}

				return ok(action, `Unknown action "${action}" (expected current or rename).`);
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
