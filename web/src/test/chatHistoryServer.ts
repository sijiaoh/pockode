import { IDLE_TURN } from "../lib/activity";
import type * as WSStoreModule from "../lib/wsStore";
import type {
	ChatMessagesHistoryResult,
	HistorySeq,
	ServerNotification,
} from "../types/message";

type RPCActions = ReturnType<
	typeof WSStoreModule.useWSStore.getState
>["actions"];

/**
 * One server for the whole module graph: `useChatMessages` reads the RPCs off
 * the store once, when it is first imported, so the stubs are bound once and
 * read whatever this holds at call time.
 */
const server = {
	/** History records, split into pages, oldest page first. */
	pages: [] as unknown[][],
	/** How many older pages have been asked for. */
	requests: 0,
	/** Answers the page request in flight, held until the test lands it. */
	pending: null as (() => void) | null,
	/** Where the transcript's subscription delivers live records. */
	notify: null as ((notification: ServerNotification) => void) | null,
};

export function resetChatHistoryServer(pages: unknown[][]) {
	server.pages = pages;
	server.requests = 0;
	server.pending = null;
	server.notify = null;
}

export function chatHistoryRequests(): number {
	return server.requests;
}

/** Answers the page request in flight; false when there is none. */
export function answerPageRequest(): boolean {
	const answer = server.pending;
	if (!answer) return false;
	server.pending = null;
	answer();
	return true;
}

/** Delivers `records` to the transcript as live output, in order. */
export function streamRecords(records: unknown[]) {
	const { notify } = server;
	if (!notify) throw new Error("the transcript has not subscribed");
	for (const record of records) notify(record as ServerNotification);
}

// A page's cursor is its own index: asking with `i` returns page `i - 1`. Page 0
// has nothing before it, so it hands out no cursor.
function page(index: number): ChatMessagesHistoryResult {
	const next = index > 0 ? index : undefined;
	return {
		history: server.pages[index],
		has_more: next !== undefined,
		next_before_seq: next,
	};
}

/**
 * Stands in for the server end of a transcript's history, and nothing else:
 * subscribing hands back the newest page, `chat.messages.history` each older
 * one, on the real store, which is marked connected. Live records reach the
 * subscription only when the test streams them (`streamRecords`). Everything
 * above the RPCs is the app's own — `useChatMessages` replays the records,
 * splices each page in with `prependHistoryPage`, and keeps the paging flags. A
 * request for an older page is held until the test answers it
 * (`answerPageRequest`).
 *
 * For a `vi.mock` factory, so it runs before anything reads the actions:
 *
 * ```ts
 * vi.mock("../../lib/wsStore", async (importOriginal) =>
 *   (await import("../../test/chatHistoryServer")).stubChatHistoryRpc(
 *     await importOriginal<typeof import("../../lib/wsStore")>(),
 *   ),
 * );
 * ```
 *
 * Dynamically imported there because a factory is hoisted above every import.
 */
export function stubChatHistoryRpc(
	module: typeof WSStoreModule,
): typeof WSStoreModule {
	const { actions } = module.useWSStore.getState();
	const stubs = {
		chatMessagesSubscribe: async (
			_sessionId: string,
			callback: (notification: ServerNotification) => void,
		) => {
			server.notify = callback;
			return {
				id: "transcript-fixture",
				initial: { ...page(server.pages.length - 1), turn: IDLE_TURN },
			};
		},
		chatMessagesUnsubscribe: async () => {},
		chatMessagesHistory: (_sessionId: string, beforeSeq: HistorySeq) => {
			server.requests++;
			return new Promise<ChatMessagesHistoryResult>((resolve) => {
				server.pending = () => resolve(page(beforeSeq - 1));
			});
		},
	} satisfies Partial<RPCActions>;
	module.useWSStore.setState({
		status: "connected",
		actions: { ...actions, ...stubs },
	});
	return module;
}
