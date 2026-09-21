import type { JSONRPCRequester } from "json-rpc-2.0";
import type { FileContent } from "../../types/contents";
import type {
	ChatMessagesHistoryPage,
	HistorySeq,
	SessionDetail,
	SessionListPage,
} from "../../types/message";

interface SessionViewListParams {
	worktree: string;
	exclude_work_sessions?: boolean;
	cursor?: string;
}

interface SessionViewDeleteParams {
	worktree: string;
	session_id: string;
}

/**
 * A worktree whose session data the server still holds, and how much of it.
 *
 * `exists` is what separates "another worktree" from "a worktree that was
 * deleted": both keep their sessions, and only the first can be switched to.
 * A worktree with no sessions left is not listed at all, which is how the last
 * deletion takes it out of the filter.
 */
export interface SessionViewWorktree {
	worktree: string;
	exists: boolean;
	session_count: number;
}

interface SessionViewWorktreesResult {
	worktrees: SessionViewWorktree[];
}

interface SessionViewGetParams {
	worktree: string;
	session_id: string;
}

interface SessionViewGetResult {
	session: SessionDetail;
}

interface SessionViewHistoryParams {
	worktree: string;
	session_id: string;
	before_seq?: HistorySeq;
}

interface SessionViewAttachmentParams {
	worktree: string;
	session_id: string;
	id: string;
}

interface SessionViewAttachmentResult {
	file: FileContent;
}

/**
 * Reading the sessions of a worktree the connection is not bound to —
 * including one that has been deleted, whose session data the server keeps.
 *
 * Every method names the worktree it reads from, where `""` is the main
 * worktree, and none of them writes: there is no way here to say anything to a
 * session, which is what makes a screen fed from these read-only by
 * construction rather than by the UI remembering to hide a button.
 *
 * There is no subscription either — what is read belongs to a conversation the
 * reader cannot take part in — so these are one-shot requests and what they
 * return does not update itself.
 */
export interface SessionViewActions {
	/** Every worktree that still has sessions, deleted ones included. */
	sessionViewWorktrees: () => Promise<SessionViewWorktree[]>;
	/**
	 * A page of one worktree's session list. Pages exactly as the live list's
	 * `session.list.page` does, down to the cursor being opaque, so one pager
	 * serves both.
	 */
	sessionViewList: (
		worktree: string,
		excludeWorkSessions: boolean,
		cursor?: string,
	) => Promise<SessionListPage>;
	/**
	 * Deletes a session out of a worktree the connection is not bound to.
	 *
	 * The one method here that changes anything, and it does not contradict the
	 * namespace: what is read-only is the *conversation* — there is no execution
	 * environment left to continue it with. Data the server keeps forever still
	 * needs a way out, and this is it. Nothing is pushed afterwards, so whoever
	 * calls it re-reads the list itself.
	 */
	sessionViewDelete: (worktree: string, sessionId: string) => Promise<void>;
	sessionViewGet: (
		worktree: string,
		sessionId: string,
	) => Promise<SessionDetail>;
	/**
	 * A page of the transcript. Pages exactly as `chat.messages.history` does,
	 * down to the shape of the reply, so one transcript reader serves both;
	 * omitting `beforeSeq` asks for the newest page, which is what subscribing
	 * would otherwise have handed over.
	 */
	sessionViewHistory: (
		worktree: string,
		sessionId: string,
		beforeSeq?: HistorySeq,
	) => Promise<ChatMessagesHistoryPage>;
	sessionViewAttachment: (
		worktree: string,
		sessionId: string,
		id: string,
	) => Promise<FileContent>;
}

export function createSessionViewActions(
	getClient: () => JSONRPCRequester<void> | null,
): SessionViewActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		sessionViewWorktrees: async () => {
			const result = (await requireClient().request(
				"session_view.worktrees",
				{},
			)) as SessionViewWorktreesResult;
			return result.worktrees;
		},

		sessionViewList: async (worktree, excludeWorkSessions, cursor) => {
			return (await requireClient().request("session_view.list", {
				worktree,
				exclude_work_sessions: excludeWorkSessions,
				...(cursor !== undefined ? { cursor } : {}),
			} satisfies SessionViewListParams)) as SessionListPage;
		},

		sessionViewDelete: async (worktree, sessionId) => {
			await requireClient().request("session_view.delete", {
				worktree,
				session_id: sessionId,
			} satisfies SessionViewDeleteParams);
		},

		sessionViewGet: async (worktree, sessionId) => {
			const result = (await requireClient().request("session_view.get", {
				worktree,
				session_id: sessionId,
			} satisfies SessionViewGetParams)) as SessionViewGetResult;
			return result.session;
		},

		sessionViewHistory: async (worktree, sessionId, beforeSeq) => {
			return (await requireClient().request("session_view.history", {
				worktree,
				session_id: sessionId,
				...(beforeSeq !== undefined ? { before_seq: beforeSeq } : {}),
			} satisfies SessionViewHistoryParams)) as ChatMessagesHistoryPage;
		},

		sessionViewAttachment: async (worktree, sessionId, id) => {
			const result = (await requireClient().request("session_view.attachment", {
				worktree,
				session_id: sessionId,
				id,
			} satisfies SessionViewAttachmentParams)) as SessionViewAttachmentResult;
			return result.file;
		},
	};
}
