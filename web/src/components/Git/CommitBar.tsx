import { useState } from "react";
import { useGitBranches } from "../../hooks/useGitBranches";
import { useGitCreateCommit } from "../../hooks/useGitCreateCommit";
import { useGitStatus } from "../../hooks/useGitStatus";
import { describeCommitAction, stagedSubmodules } from "../../types/git";
import { BottomActionBar } from "../ui";
import CommitSheet, { type LastCommit } from "./CommitSheet";

/**
 * The panel's fixed bottom row: one button, whatever there is to commit.
 *
 * It reads the same two queries the rest of the panel does — react-query serves
 * both from cache — and renders outside DiffTab's loading/error branch, so the
 * action stays reachable however far the user has scrolled into History.
 */
function CommitBar() {
	const { data: status } = useGitStatus();
	const { data: branches } = useGitBranches();
	const commitMutation = useGitCreateCommit();
	const [isOpen, setIsOpen] = useState(false);

	// Root repository only: git.add stages a submodule's file in that
	// submodule's index, which a root commit does not touch.
	const stagedCount = status ? status.staged.length : null;
	const head = branches?.head;
	const lastCommit: LastCommit | null = head?.hash
		? {
				message: head.message,
				pushedTo: branches?.sync.head_pushed ? branches.sync.upstream : null,
			}
		: null;

	const action = describeCommitAction(stagedCount, lastCommit !== null);

	return (
		<BottomActionBar>
			<button
				type="button"
				onClick={() => setIsOpen(true)}
				disabled={!action.enabled}
				className="flex min-h-[44px] w-full items-center justify-center rounded-lg bg-th-accent text-sm font-medium text-th-accent-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{action.label}
			</button>

			{isOpen && (
				<CommitSheet
					stagedCount={stagedCount ?? 0}
					submodules={status ? stagedSubmodules(status) : []}
					lastCommit={lastCommit}
					amendInitially={action.amend}
					onClose={() => setIsOpen(false)}
					// The sheet reports the outcome itself and stays open on failure,
					// so the error stops there rather than becoming an unhandled
					// rejection here.
					onCommit={async (message, amend) => {
						await commitMutation.mutateAsync({ message, amend });
						setIsOpen(false);
					}}
				/>
			)}
		</BottomActionBar>
	);
}

export default CommitBar;
