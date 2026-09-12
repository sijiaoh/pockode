import type { JSONRPCRequester } from "json-rpc-2.0";
import type { FileContent } from "../../types/contents";
import type {
	GitBranches,
	GitDiffData,
	GitLogResult,
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
	stage: (paths: string[]) => Promise<void>;
	unstage: (paths: string[]) => Promise<void>;
	/** Reverts unstaged edits; the server decides per path whether that means deleting it. */
	discard: (paths: string[]) => Promise<void>;
	commit: (message: string, amend: boolean) => Promise<void>;
	getBranches: () => Promise<GitBranches>;
	checkout: (branch: string) => Promise<void>;
	createBranch: (name: string) => Promise<void>;
	/** Named for the git command rather than "fetch", which the global already is. */
	fetchRemote: () => Promise<void>;
	/** Resolves to the number of commits the fast-forward brought in. */
	pull: () => Promise<number>;
	push: (force: boolean) => Promise<void>;
}

export function createGitActions(
	getClient: () => JSONRPCRequester<void> | null,
): GitActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
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
		stage: async (paths: string[]): Promise<void> => {
			await requireClient().request("git.add", { paths });
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
	};
}
