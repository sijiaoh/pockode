import type { Message } from "../types/message";
import { messageRunsById, perMessage, perTranscript } from "./transcriptMemo";

/**
 * The calls that stop a background task: Claude's `TaskStop`, and the names it
 * had before — `KillShell`, which history holds, and `KillBash`, which claude
 * 2.1.330 still accepts as an alias. A Set, not an object lookup: a tool name
 * is the agent's string.
 */
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);

export function isStopTool(toolName: string): boolean {
	return STOP_TOOLS.has(toolName);
}

/** The task a stop names: `task_id`, or `shell_id` on the older names. */
export function stoppedTaskId(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { task_id, shell_id } = input as Record<string, unknown>;
	if (typeof task_id === "string" && task_id) return task_id;
	if (typeof shell_id === "string" && shell_id) return shell_id;
	return undefined;
}

/** What a stop said it stopped. */
export interface StopResult {
	message: string;
	command?: string;
}

/**
 * A stop's answer, read off the envelope claude 2.1.330 answers with — a JSON
 * object of `message`, `task_id`, `task_type` and `command`. `KillShell`
 * answered with `message` and `shell_id`. Null for any other shape, which is
 * then drawn as it came.
 */
export function parseStopResult(result: string): StopResult | null {
	const text = result.trim();
	if (!text.startsWith("{")) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { message, command } = parsed as Record<string, unknown>;
	if (typeof message !== "string") return null;
	return {
		message,
		...(typeof command === "string" && command ? { command } : {}),
	};
}

/** A stop's answer as the text its body shows: the sentence, then the command. */
export function stopResultText(stopped: StopResult): string {
	return stopped.command
		? `${stopped.message}\n${stopped.command}`
		: stopped.message;
}

const NO_TARGETS: ReadonlySet<string> = new Set();
const NO_NAMED: readonly string[] = [];

/** The calls this message's stops name, by their `originToolUseId`. */
const namedByStops = perMessage((message): readonly string[] => {
	const named: string[] = [];
	for (const run of messageRunsById(message).values()) {
		if (run.originToolUseId && isStopTool(run.name)) {
			named.push(run.originToolUseId);
		}
	}
	return named.length > 0 ? named : NO_NAMED;
});

/**
 * The calls named by a stop's `originToolUseId` whose rows are loaded — the
 * ones its `Go to call` can land on. The answer is the whole transcript's (the
 * origin is usually in an earlier bubble than the stop), so it is read here,
 * over every message, rather than by the stop's row. Put together from each
 * message's own (`perMessage`): a streamed record re-reads only the message it
 * changed.
 */
export const loadedStopTargets = perTranscript(
	(messages: Message[]): ReadonlySet<string> => {
		const named = messages.flatMap((message) => namedByStops(message));
		if (named.length === 0) return NO_TARGETS;
		const loaded = named.filter((id) =>
			messages.some((message) => messageRunsById(message).has(id)),
		);
		return loaded.length > 0 ? new Set(loaded) : NO_TARGETS;
	},
);
