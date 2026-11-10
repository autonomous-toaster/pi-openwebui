/**
 * set_tasks — show a live task checklist in the Open WebUI chat.
 *
 * Open WebUI already has the UI: the frontend listens for `chat:message:tasks` and renders
 * the list (tools/builtin.py emits it for chat models). Agents never emitted it, so
 * `patches/agent_tasks.py` teaches `Output.tool()` to do the same. The checklist is live
 * state, not history: Open WebUI keeps it in the page, so it disappears on reload.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failed, ok } from "./common.ts";

const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
const MAX_TASKS = 20;

interface TaskItem {
	content: string;
	status: (typeof STATUSES)[number];
}

interface TasksParams {
	tasks?: unknown;
}

function normalize(raw: unknown): TaskItem[] {
	if (!Array.isArray(raw)) return [];
	const items: TaskItem[] = [];
	for (const entry of raw.slice(0, MAX_TASKS)) {
		if (typeof entry === "string") {
			const content = entry.trim();
			if (content) items.push({ content, status: "pending" });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const content = String(record.content ?? "").trim();
		if (!content) continue;
		const status = STATUSES.includes(record.status as (typeof STATUSES)[number])
			? (record.status as TaskItem["status"])
			: "pending";
		items.push({ content, status });
	}
	return items;
}

export function registerTasksTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "set_tasks",
		label: "Set the task list",
		description:
			"Publish the current task checklist to the Open WebUI chat so the user can follow progress. Replaces the previous list.",
		promptSnippet: "Publish a task checklist the user can follow in Open WebUI",
		promptGuidelines: [
			"Use set_tasks when work has three or more steps, and call it again as steps change state instead of narrating progress in prose.",
			"set_tasks replaces the whole list: send every task each time, with exactly one in_progress.",
		],
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					content: Type.String({ description: "One short imperative line" }),
					status: Type.Optional(StringEnum(STATUSES, { description: "default pending" })),
				}),
				{ description: "The complete checklist, in order" },
			),
		}),

		async execute(_toolCallId, params: TasksParams) {
			const action = "set_tasks";
			try {
				const tasks = normalize(params.tasks);
				if (!tasks.length) return ok(action, "Provide `tasks` as a non-empty list.");

				const counts = tasks.reduce<Record<string, number>>((acc, task) => {
					acc[task.status] = (acc[task.status] ?? 0) + 1;
					return acc;
				}, {});
				const summary = STATUSES.filter((status) => counts[status])
					.map((status) => `${counts[status]} ${status}`)
					.join(", ");

				// The Open WebUI patch emits the event from these arguments; the result only
				// has to confirm to the model, so keep it small.
				return ok(action, `${tasks.length} tasks (${summary}):\n${tasks.map((task, index) => `${index + 1}. [${task.status}] ${task.content}`).join("\n")}`);
			} catch (err) {
				return failed(action, err);
			}
		},
	});
}
