import type { JSONRPCRequester } from "json-rpc-2.0";
import type { FileContent } from "../../types/contents";
import type {
	CommitDraftRequest,
	GitAbortResult,
	GitBranches,
	GitDiffData,
	GitLogResult,
	GitOperationKind,
	GitPullResult,
	GitShowResult,
	GitStatus,
} from "../../types/git";

export interface GitActions {
	getStatus: () => Promise<GitStatus>;
	getLog: (limit?: number) => Promise<GitLogResult>;
	getCommit: (hash: string) => Promise<GitShowResult>;
	getCommitDiff: (
		hash: string,
		path: string,
		hideWhitespace?: boolean,
	) => Promise<GitDiffData>;
	/** The file as it stood in that commit, shaped like a `file.get` file. */
	getCommitFile: (hash: string, path: string) => Promise<FileContent>;
	/**
	 * `resolve` marks conflicted paths resolved by staging them; without it the
	 * server refuses a conflicted path (-32007), as a stage chosen from an older
	 * status would record its markers.
	 */
	stage: (paths: string[], resolve?: boolean) => Promise<void>;
	unstage: (paths: string[]) => Promise<void>;
	/** Reverts unstaged edits; the server decides per path whether that means deleting it. */
	discard: (paths: string[]) => Promise<void>;
	commit: (message: string, amend: boolean) => Promise<void>;
	/**
	 * Asks an AI CLI for a message describing what committing now would record.
	 * A paid call that can take the server's full 90s: never retry it, and stop
	 * one no longer waited for with `cancelCommitDraft`.
	 */
	draftCommitMessage: (request: CommitDraftRequest) => Promise<string>;
	/** Idempotent: an id that already ended, or never ran, is not an error. */
	cancelCommitDraft: (draftId: string) => Promise<void>;
	getBranches: () => Promise<GitBranches>;
	checkout: (branch: string) => Promise<void>;
	createBranch: (name: string) => Promise<void>;
	/** Named for the git command rather than "fetch", which the global already is. */
	fetchRemote: () => Promise<void>;
	/** Resolves to the number of commits the fast-forward brought in. */
	pull: () => Promise<number>;
	push: (force: boolean) => Promise<void>;
	/**
	 * Abandons the operation of `kind` in progress. Refused with -32005 when
	 * that is no longer the one in progress; nothing runs then.
	 */
	abort: (kind: GitOperationKind) => Promise<GitAbortResult>;
}

/**
 * @param getDraftClient Requester for `git.commit.draft`, whose answer comes
 * only once the CLI does — see COMMIT_DRAFT_RPC_TIMEOUT_MS.
 */
export function createGitActions(
	getClient: () => JSONRPCRequester<void> | null,
	getDraftClient: () => JSONRPCRequester<void> | null,
): GitActions {
	const requireClient = (
		get: () => JSONRPCRequester<void> | null = getClient,
	): JSONRPCRequester<void> => {
		const client = get();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		getStatus: async (): Promise<GitStatus> => {
			return requireClient().request("git.status", {});
		},
		getLog: async (limit?: number): Promise<GitLogResult> => {
			return requireClient().request("git.log", { limit: limit ?? 50 });
		},
		getCommit: async (hash: string): Promise<GitShowResult> => {
			return requireClient().request("git.show", { hash });
		},
		getCommitDiff: async (
			hash: string,
			path: string,
			hideWhitespace = false,
		): Promise<GitDiffData> => {
			return requireClient().request("git.show.diff", {
				hash,
				path,
				hide_whitespace: hideWhitespace,
			});
		},
		getCommitFile: async (hash: string, path: string): Promise<FileContent> => {
			return requireClient().request("git.show.file", { hash, path });
		},
		stage: async (paths: string[], resolve = false): Promise<void> => {
			await requireClient().request("git.add", { paths, resolve });
		},
		unstage: async (paths: string[]): Promise<void> => {
			await requireClient().request("git.reset", { paths });
		},
		discard: async (paths: string[]): Promise<void> => {
			await requireClient().request("git.discard", { paths });
		},
		commit: async (message: string, amend: boolean): Promise<void> => {
			await requireClient().request("git.commit", { message, amend });
		},
		draftCommitMessage: async ({
			draftId,
			agentType,
			model,
			effort,
			amend,
		}: CommitDraftRequest): Promise<string> => {
			const result: { message: string } = await requireClient(
				getDraftClient,
			).request("git.commit.draft", {
				draft_id: draftId,
				agent_type: agentType,
				model,
				effort,
				amend,
			});
			return result.message;
		},
		cancelCommitDraft: async (draftId: string): Promise<void> => {
			await requireClient().request("git.commit.draft.cancel", {
				draft_id: draftId,
			});
		},
		getBranches: async (): Promise<GitBranches> => {
			return requireClient().request("git.branches", {});
		},
		checkout: async (branch: string): Promise<void> => {
			await requireClient().request("git.checkout", { branch });
		},
		createBranch: async (name: string): Promise<void> => {
			await requireClient().request("git.branch.create", { name });
		},
		fetchRemote: async (): Promise<void> => {
			await requireClient().request("git.fetch", {});
		},
		pull: async (): Promise<number> => {
			const result: GitPullResult = await requireClient().request(
				"git.pull",
				{},
			);
			return result.commits;
		},
		push: async (force: boolean): Promise<void> => {
			await requireClient().request("git.push", { force });
		},
		abort: async (kind: GitOperationKind): Promise<GitAbortResult> => {
			return requireClient().request("git.abort", { kind });
		},
	};
}
