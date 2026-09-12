import { GitBranch } from "lucide-react";
import { useState } from "react";
import {
	useGitBranchActions,
	useGitBranches,
} from "../../hooks/useGitBranches";
import { useGitSyncActions } from "../../hooks/useGitSync";
import type { GitHead } from "../../types/git";
import BranchName from "./BranchName";
import BranchSheet from "./BranchSheet";
import NewBranchSheet from "./NewBranchSheet";
import SyncChip from "./SyncChip";
import SyncSheet from "./SyncSheet";

/**
 * The panel's fixed top row: which branch this worktree is on, and the way into
 * the branch sheet.
 *
 * It renders outside DiffTab's loading/error branch on purpose — a failing
 * git.status must not take branch identity down with it.
 */
function BranchBar() {
	const { data: branches, isLoading, error } = useGitBranches();
	const { checkoutMutation, createMutation } = useGitBranchActions();
	const { fetchMutation, pullMutation, pushMutation } = useGitSyncActions();
	const [sheet, setSheet] = useState<"branches" | "new" | "sync" | null>(null);

	const head = branches?.head;
	const sync = branches?.sync;
	// A detached HEAD tracks nothing, and a repository without a remote has
	// nothing to sync with: in both cases the chip would have no state to show.
	const showChip = Boolean(sync?.has_remote) && head?.detached === false;

	return (
		<div className="flex min-h-[44px] shrink-0 items-center gap-1 border-b border-th-border px-2">
			{/*
			 * Data first: a background refetch that fails still leaves the branch
			 * name we already have, and replacing it with an error would take the
			 * bar down for exactly the reason it renders outside DiffTab's error
			 * branch in the first place.
			 */}
			{!head ? (
				isLoading ? (
					<div className="flex flex-1 items-center gap-2 px-2">
						<div className="h-4 w-4 shrink-0 animate-pulse rounded bg-th-text-muted/20" />
						<div className="h-4 flex-1 animate-pulse rounded bg-th-text-muted/20" />
					</div>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-sm text-th-error">
						<GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />
						<span
							className="truncate"
							title={error instanceof Error ? error.message : undefined}
						>
							Branch unavailable
						</span>
					</div>
				)
			) : (
				<button
					type="button"
					onClick={() => setSheet("branches")}
					className="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 rounded px-2 text-th-text-primary pointer-coarse:min-h-11 transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					aria-label={`Switch branch, currently ${headLabel(head)}`}
				>
					<GitBranch
						className="h-4 w-4 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
					<BranchName name={headLabel(head)} />
				</button>
			)}

			{showChip && sync && (
				<SyncChip sync={sync} onClick={() => setSheet("sync")} />
			)}

			{sheet === "branches" && branches && (
				<BranchSheet
					branches={branches}
					onClose={() => setSheet(null)}
					onCheckout={async (branch) => {
						await checkoutMutation.mutateAsync(branch);
						setSheet(null);
					}}
					onNewBranch={() => setSheet("new")}
				/>
			)}

			{sheet === "sync" && sync && (
				<SyncSheet
					sync={sync}
					onClose={() => setSheet(null)}
					// The sheet reports the outcome itself and stays open to show it,
					// so the errors stop here rather than becoming unhandled rejections.
					onFetch={() => fetchMutation.mutateAsync()}
					onPull={() => pullMutation.mutateAsync()}
					onPush={(force) => pushMutation.mutateAsync(force)}
				/>
			)}

			{sheet === "new" && head && (
				<NewBranchSheet
					base={headLabel(head)}
					// Back to the branch list it was opened from; only a successful
					// create closes the flow outright.
					onClose={() => setSheet("branches")}
					onCreate={async (name) => {
						await createMutation.mutateAsync(name);
						setSheet(null);
					}}
				/>
			)}
		</div>
	);
}

function headLabel(head: GitHead): string {
	return head.detached ? `detached @ ${head.hash}` : head.branch;
}

export default BranchBar;
