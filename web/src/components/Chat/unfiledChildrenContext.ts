import { createContext, useContext, useRef } from "react";
import {
	type LatestChild,
	type UnfiledChildren,
	unfiledChildren,
} from "../../lib/subagentRun";
import type { ContentPart, Message } from "../../types/message";

const EMPTY: ReadonlyMap<string, UnfiledChildren> = new Map();

/**
 * The transcript's unfiled subagent children, by parent call. A context rather
 * than a prop because the answer is the whole transcript's and the reader is a
 * row inside one memoized bubble: threading it through would re-render every
 * bubble whenever any page loads.
 */
export const UnfiledChildrenContext = createContext(EMPTY);

export function useUnfiledChildren(
	toolUseId: string,
): UnfiledChildren | undefined {
	return useContext(UnfiledChildrenContext).get(toolUseId);
}

function sameLatest(a?: LatestChild, b?: LatestChild): boolean {
	if (a?.kind === "text" && b?.kind === "text") return a.text === b.text;
	if (a?.kind === "call" && b?.kind === "call") {
		return a.name === b.name && a.input === b.input;
	}
	return a === b;
}

// What a row reads off one unfiled part: a call by what its window line
// draws, anything else by being the same part. Not by identity: a streaming
// text or thinking is a new object on every delta, and a running call on every
// line of output, and re-rendering every subagent row in the transcript for
// what none of them shows would be the cost. What a text says is compared
// through `latest`.
function sameShown(a: ContentPart, b: ContentPart): boolean {
	if (a.type === "tool_call" && b.type === "tool_call") {
		return (
			a.tool.id === b.tool.id &&
			a.tool.status === b.tool.status &&
			a.tool.name === b.tool.name &&
			a.tool.input === b.tool.input &&
			a.tool.seenAt === b.tool.seenAt
		);
	}
	if (a.type === "permission_request" || a.type === "question_record") {
		return a === b;
	}
	return a.type === b.type && a.id === b.id;
}

function sameChildren(a: UnfiledChildren, b?: UnfiledChildren): boolean {
	return (
		b !== undefined &&
		a.parts.length === b.parts.length &&
		a.parts.every((part, i) => sameShown(part, b.parts[i])) &&
		sameLatest(a.latest, b.latest)
	);
}

function sameParts(
	a: ReadonlyMap<string, UnfiledChildren>,
	b: ReadonlyMap<string, UnfiledChildren>,
): boolean {
	if (a.size !== b.size) return false;
	for (const [id, unfiled] of a) {
		if (!sameChildren(unfiled, b.get(id))) return false;
	}
	return true;
}

/**
 * The value to provide, kept the same object while what it says does not change:
 * every streamed delta hands over a new transcript, and a new map each time
 * would re-render every subagent row in it.
 */
export function useUnfiledChildrenValue(
	messages: Message[],
): ReadonlyMap<string, UnfiledChildren> {
	const previous = useRef<ReadonlyMap<string, UnfiledChildren>>(EMPTY);
	const next = unfiledChildren(messages);
	if (!sameParts(previous.current, next)) previous.current = next;
	return previous.current;
}
