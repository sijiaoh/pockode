import { createContext, useContext, useRef } from "react";
import {
	type LatestChild,
	type UnfiledChildren,
	unfiledChildren,
} from "../../lib/subagentRun";
import type { Message } from "../../types/message";

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

function sameCounts(
	a: ReadonlyMap<string, UnfiledChildren>,
	b: ReadonlyMap<string, UnfiledChildren>,
): boolean {
	if (a.size !== b.size) return false;
	for (const [id, counts] of a) {
		const other = b.get(id);
		if (
			other?.count !== counts.count ||
			other.steps !== counts.steps ||
			!sameLatest(other.latest, counts.latest)
		) {
			return false;
		}
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
	if (!sameCounts(previous.current, next)) previous.current = next;
	return previous.current;
}
