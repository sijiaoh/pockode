import { createContext, useMemo, useRef } from "react";
import type { Message, UserMessage } from "../../types/message";
import { discardedMessages } from "../../utils/discardedMessage";

type Discarded = ReadonlyMap<string, UserMessage | undefined>;

const EMPTY: Discarded = new Map();

interface DiscardedMessages {
	/**
	 * Every message a Stop threw away, by server id, mapped to the message where
	 * it is loaded (`discardedMessages`).
	 */
	discarded: Discarded;
	/** Whether a message not loaded may yet arrive with an older page. */
	hasMoreHistory: boolean;
}

/**
 * A context because the reader is the end of a stopped turn inside one
 * memoized bubble: a prop would re-render every bubble whenever the transcript
 * changed.
 */
export const DiscardedMessagesContext = createContext<DiscardedMessages>({
	discarded: EMPTY,
	hasMoreHistory: false,
});

function sameEntries(a: Discarded, b: Discarded): boolean {
	if (a.size !== b.size) return false;
	for (const [id, message] of a) {
		if (!b.has(id) || b.get(id) !== message) return false;
	}
	return true;
}

/**
 * The context's value, kept the same object while the answer is: the transcript
 * changes on every streamed word, and almost never in a way this map sees.
 */
export function useDiscardedMessagesValue(
	messages: Message[],
	hasMoreHistory: boolean,
): DiscardedMessages {
	const previous = useRef<Discarded>(EMPTY);
	const next = discardedMessages(messages);
	if (!sameEntries(previous.current, next)) previous.current = next;
	const discarded = previous.current;
	return useMemo(
		() => ({ discarded, hasMoreHistory }),
		[discarded, hasMoreHistory],
	);
}
