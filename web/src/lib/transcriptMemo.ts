import type { ContentPart, Message, ToolRun } from "../types/message";

/**
 * Memoizers for the facts read off the whole loaded transcript
 * (docs/code/frontend-state.md#transcript-wide-facts). They lean on the
 * reducer's one promise: a message, and the transcript array, are never
 * changed in place — an event hands back new objects for what it touched and
 * the very same ones for everything else.
 *
 * - `perTranscript`: derived once per transcript array, however many readers
 *   ask for it in a commit (the list, the status line, the strip, a subagent's
 *   transcript all read the same facts).
 * - `perMessage`: derived once per message object, so a streamed record — which
 *   changes one message — re-walks that message and not the other 600; the
 *   transcript-wide answer is then put together from the cached parts.
 */
export function perTranscript<T>(
	derive: (messages: Message[]) => T,
): (messages: Message[]) => T {
	const cache = new WeakMap<Message[], T>();
	return (messages) => {
		if (cache.has(messages)) return cache.get(messages) as T;
		const value = derive(messages);
		cache.set(messages, value);
		return value;
	};
}

export function perMessage<T>(
	derive: (message: Message) => T,
): (message: Message) => T {
	const cache = new WeakMap<Message, T>();
	return (message) => {
		if (cache.has(message)) return cache.get(message) as T;
		const value = derive(message);
		cache.set(message, value);
		return value;
	};
}

const NO_RUNS: ReadonlyMap<string, ToolRun> = new Map();

/**
 * Every run in a message, at any depth, by its `tool_use_id`. Should an id
 * ever repeat, the newest wins — the last in depth-first order, the one
 * `findToolRun` finds.
 */
export const messageRunsById = perMessage(
	(message): ReadonlyMap<string, ToolRun> => {
		if (message.role !== "assistant") return NO_RUNS;
		const runs = new Map<string, ToolRun>();
		const visit = (parts: ContentPart[]) => {
			for (const part of parts) {
				if (part.type !== "tool_call") continue;
				runs.set(part.tool.id, part.tool);
				if (part.tool.children) visit(part.tool.children);
			}
		};
		visit(message.parts);
		return runs.size > 0 ? runs : NO_RUNS;
	},
);

/** The loaded run with this `tool_use_id`, wherever in the transcript it is. */
export function findLoadedRun(
	messages: Message[],
	toolUseId: string,
): ToolRun | undefined {
	for (const message of messages) {
		const run = messageRunsById(message).get(toolUseId);
		if (run) return run;
	}
	return undefined;
}
