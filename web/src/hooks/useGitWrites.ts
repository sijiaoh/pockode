import { useCallback, useMemo } from "react";
import {
	type GitWrites,
	gitWriteActions,
	useWorktreeWrites,
} from "../lib/gitWriteStore";
import { useWorktreeStore } from "../lib/worktreeStore";
import { useGitDiscard } from "./useGitDiscard";
import { useGitStage } from "./useGitStage";

interface GitWriteRunner {
	/** Stages the paths, or unstages them when they are staged already. */
	toggle: (paths: string[], staged: boolean) => Promise<void>;
	/** Stages one hunk of the path, or unstages it when it is on the staged side. */
	toggleHunk: (path: string, hunkId: string, staged: boolean) => Promise<void>;
	discard: (paths: string[]) => Promise<void>;
	/** Which paths have a write queued or running, for the rows' spinners. */
	writes: GitWrites;
}

/**
 * Stage, unstage — of files or of hunks — and discard as the workspace starts them: through the write store,
 * so that two taps in a row queue instead of racing each other for this
 * worktree's `index.lock`.
 *
 * Both entry points into these actions — the file list and the open diff — go
 * through here, which is what makes the queue cover them *together*.
 */
export function useGitWriteRunner(): GitWriteRunner {
	const worktree = useWorktreeStore((s) => s.current);
	const {
		stageMutation,
		unstageMutation,
		stageHunkMutation,
		unstageHunkMutation,
	} = useGitStage();
	const discardMutation = useGitDiscard();
	const writes = useWorktreeWrites(worktree);

	const stage = stageMutation.mutateAsync;
	const unstage = unstageMutation.mutateAsync;
	const discardPaths = discardMutation.mutateAsync;
	const stageHunk = stageHunkMutation.mutateAsync;
	const unstageHunk = unstageHunkMutation.mutateAsync;

	const toggle = useCallback(
		(paths: string[], staged: boolean) =>
			gitWriteActions.run(worktree, "toggle", paths, (accepted) =>
				staged ? unstage(accepted) : stage(accepted),
			),
		[worktree, stage, unstage],
	);

	const toggleHunk = useCallback(
		(path: string, hunkId: string, staged: boolean) =>
			gitWriteActions.runHunk(worktree, path, hunkId, () =>
				staged ? unstageHunk({ path, hunkId }) : stageHunk({ path, hunkId }),
			),
		[worktree, stageHunk, unstageHunk],
	);

	const discard = useCallback(
		(paths: string[]) =>
			gitWriteActions.run(worktree, "discard", paths, discardPaths),
		[worktree, discardPaths],
	);

	return useMemo(
		() => ({ toggle, toggleHunk, discard, writes }),
		[toggle, toggleHunk, discard, writes],
	);
}
