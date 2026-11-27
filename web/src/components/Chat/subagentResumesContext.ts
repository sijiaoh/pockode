import { createContext, useContext, useRef } from "react";
import { liveResumes } from "../../lib/subagentRun";
import type { Message, ToolRun } from "../../types/message";

const EMPTY: ReadonlyMap<string, ToolRun> = new Map();

/**
 * The transcript's resumed subagents, by their call, each with the call that
 * resumed it (`liveResumes`). A context for the reason `UnfiledChildrenContext`
 * is one: the answer is the whole transcript's — the resuming call is usually
 * in a later bubble than the row — and the reader is a row inside one.
 */
export const SubagentResumesContext = createContext(EMPTY);

/** The call resuming this subagent, while one is. */
export function useSubagentResume(toolUseId: string): ToolRun | undefined {
	return useContext(SubagentResumesContext).get(toolUseId);
}

function sameResumes(
	a: ReadonlyMap<string, ToolRun>,
	b: ReadonlyMap<string, ToolRun>,
): boolean {
	if (a.size !== b.size) return false;
	for (const [id, resume] of a) {
		if (b.get(id) !== resume) return false;
	}
	return true;
}

/**
 * The value to provide, kept the same object while what it says does not
 * change. The reducer hands back a run untouched by an event as the same
 * object, so comparing the resuming runs by identity re-renders the rows only
 * when one of them did change.
 */
export function useSubagentResumesValue(
	messages: Message[],
): ReadonlyMap<string, ToolRun> {
	const previous = useRef<ReadonlyMap<string, ToolRun>>(EMPTY);
	const next = liveResumes(messages);
	if (!sameResumes(previous.current, next)) previous.current = next;
	return previous.current;
}
