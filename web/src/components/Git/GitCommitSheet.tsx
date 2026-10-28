import { useEffect, useRef } from "react";
import { useGitBranches } from "../../hooks/useGitBranches";
import { useGitCreateCommit } from "../../hooks/useGitCreateCommit";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitSyncRunner } from "../../hooks/useGitSync";
import { useWorkspaceEngine } from "../../hooks/useWorkspaceEngine";
import { getAgentLabel } from "../../lib/agentType";
import { useSyncRun } from "../../lib/gitSyncStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import { isRPCTimeout, useWSStore } from "../../lib/wsStore";
import {
	commitPausedReason,
	describeGitSync,
	stagedCount,
	stagedSubmodules,
} from "../../types/git";
import { commitPushBlocker } from "../../utils/gitSyncMessages";
import { hasSyncStatus } from "../../utils/gitSyncStatus";
import { generateUUID } from "../../utils/uuid";
import CommitSheet, {
	type CommitDraft,
	type CommitPush,
	type LastCommit,
} from "./CommitSheet";

interface Props {
	/** Pre-toggled when the sheet is opened from `Amend this commit` in a commit menu. */
	amendInitially: boolean;
	onClose: () => void;
	/** After a commit succeeded, in place of `onClose`. */
	onCommitted?: () => void;
}

/**
 * CommitSheet wired to the workspace's queries, so both of its entry points — the
 * commit bar and `Amend this commit` in a commit menu — assemble it the same way.
 *
 * It reads the same two queries the rest of the workspace does; react-query serves
 * both from cache.
 */
function GitCommitSheet({ amendInitially, onClose, onCommitted }: Props) {
	const { data: status } = useGitStatus();
	const { data: branches } = useGitBranches();
	const commitMutation = useGitCreateCommit();
	const worktree = useWorktreeStore((s) => s.current);
	const { running } = useSyncRun(worktree);
	const { startPush } = useGitSyncRunner();
	const engine = useWorkspaceEngine();
	const draftCommitMessage = useWSStore((s) => s.actions.draftCommitMessage);
	const cancelCommitDraft = useWSStore((s) => s.actions.cancelCommitDraft);

	// Ends with the worktree a draft was started in: the connection stays up
	// across a switch, so nothing else would stop a draft of the worktree left
	// behind, and its answer would land in the next one's message box. The
	// sheet itself stays mounted across the switch, so its own signal does not
	// cover this.
	const worktreeScope = useRef<AbortController | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the worktree rather than reading it — a new one is what ends the scope.
	useEffect(() => {
		const scope = new AbortController();
		worktreeScope.current = scope;
		return () => scope.abort();
	}, [worktree]);

	const draft: CommitDraft = {
		agentLabel: getAgentLabel(engine.agentType),
		run: async (amend, signal) => {
			const draftId = generateUUID();
			const scope = worktreeScope.current?.signal;
			// The server answers the draft itself as cancelled once it has
			// stopped the CLI, so the sheet hears the end the usual way.
			// Once, though closing the sheet ends both the sheet's signal and the
			// worktree scope.
			const unlisten = () => {
				signal.removeEventListener("abort", cancel);
				scope?.removeEventListener("abort", cancel);
			};
			const cancel = () => {
				unlisten();
				cancelCommitDraft(draftId).catch((err: unknown) => {
					// The CLI may still be running; only the connection closing
					// or its own timeout stops it now.
					console.error("Failed to cancel commit draft:", err);
				});
			};
			signal.addEventListener("abort", cancel);
			scope?.addEventListener("abort", cancel);
			try {
				const message = await draftCommitMessage({
					draftId,
					agentType: engine.agentType,
					model: engine.model,
					effort: engine.effort,
					amend,
				});
				// The answer can beat the cancel to the server; it still describes
				// the worktree that was left.
				return scope?.aborted ? null : message;
			} catch (err) {
				if (scope?.aborted) return null;
				// Given up on here, not there: the server's deadline only starts
				// once git has read the change, so the CLI may still be running.
				if (isRPCTimeout(err)) cancel();
				throw err;
			} finally {
				unlisten();
			}
		},
	};

	const head = branches?.head;
	const lastCommit: LastCommit | null = head?.hash
		? {
				message: head.message,
				pushedTo: branches?.sync.head_pushed ? branches.sync.upstream : null,
			}
		: null;

	const sync = branches?.sync;
	const push: CommitPush | null = hasSyncStatus(head, sync)
		? {
				publishes: describeGitSync(sync).needsPublish,
				blocked: commitPushBlocker(sync, running),
			}
		: null;

	return (
		<CommitSheet
			stagedCount={status ? stagedCount(status) : 0}
			submodules={status ? stagedSubmodules(status) : []}
			lastCommit={lastCommit}
			amendInitially={amendInitially}
			push={push}
			draft={draft}
			paused={status ? commitPausedReason(status) : null}
			onClose={onClose}
			// The sheet reports the outcome itself and stays open on failure, so
			// the error stops there rather than becoming an unhandled rejection.
			onCommit={async (message, amend, withPush) => {
				await commitMutation.mutateAsync({ message, amend });
				// Only once the commit is in: a failed push keeps it, a failed
				// commit pushes nothing. From here it is a push started from the
				// Sync sheet and then left — the sync store owns it, and reports
				// it through the chip, the banner and the Sync sheet.
				if (withPush && sync) {
					// The counts on screen predate the commit, and the success
					// sentence reports what the push sent: one more commit, unless
					// amend replaced one the upstream never had.
					startPush({ ...sync, ahead: sync.ahead + (amend ? 0 : 1) }, false);
				}
				(onCommitted ?? onClose)();
			}}
		/>
	);
}

export default GitCommitSheet;
