import { useGitBranches } from "../../hooks/useGitBranches";
import { useGitCreateCommit } from "../../hooks/useGitCreateCommit";
import { useGitStatus } from "../../hooks/useGitStatus";
import { stagedSubmodules } from "../../types/git";
import CommitSheet, { type LastCommit } from "./CommitSheet";

interface Props {
	/** Pre-toggled when the sheet is opened from the HEAD row's `⋯`. */
	amendInitially: boolean;
	onClose: () => void;
}

/**
 * CommitSheet wired to the panel's queries, so both of its entry points — the
 * commit bar and the amend action on the HEAD row — assemble it the same way.
 *
 * It reads the same two queries the rest of the panel does; react-query serves
 * both from cache.
 */
function GitCommitSheet({ amendInitially, onClose }: Props) {
	const { data: status } = useGitStatus();
	const { data: branches } = useGitBranches();
	const commitMutation = useGitCreateCommit();

	const head = branches?.head;
	const lastCommit: LastCommit | null = head?.hash
		? {
				message: head.message,
				pushedTo: branches?.sync.head_pushed ? branches.sync.upstream : null,
			}
		: null;

	return (
		<CommitSheet
			// Root repository only: git.add stages a submodule's file in that
			// submodule's index, which a root commit does not touch.
			stagedCount={status?.staged.length ?? 0}
			submodules={status ? stagedSubmodules(status) : []}
			lastCommit={lastCommit}
			amendInitially={amendInitially}
			onClose={onClose}
			// The sheet reports the outcome itself and stays open on failure, so
			// the error stops there rather than becoming an unhandled rejection.
			onCommit={async (message, amend) => {
				await commitMutation.mutateAsync({ message, amend });
				onClose();
			}}
		/>
	);
}

export default GitCommitSheet;
