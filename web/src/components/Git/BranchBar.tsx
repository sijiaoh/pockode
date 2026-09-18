import { GitBranch } from "lucide-react";
import { useState } from "react";
import {
	useGitBranchActions,
	useGitBranches,
} from "../../hooks/useGitBranches";
import { gitSyncActions, useSyncRun } from "../../lib/gitSyncStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { GitHead } from "../../types/git";
import BranchName from "./BranchName";
import BranchSheet from "./BranchSheet";
import ErrorBanner from "./ErrorBanner";
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
	const [sheet, setSheet] = useState<"branches" | "new" | "sync" | null>(null);
	const worktree = useWorktreeStore((s) => s.current);
	const { running, outcome } = useSyncRun(worktree);

	const head = branches?.head;
	const sync = branches?.sync;
	// A detached HEAD tracks nothing, and a repository without a remote has
	// nothing to sync with: in both cases the chip would have no state to show.
	const showChip = Boolean(sync?.has_remote) && head?.detached === false;

	// A sync failure belongs in the sheet whenever the sheet is on screen, and
	// under the bar whenever it is not — one outcome, shown wherever the user is.
	// The test is whether the sheet actually renders, not whether it is selected:
	// without `sync` there is no sheet to hold the message.
	const syncSheetOpen = sheet === "sync" && Boolean(sync);
	// Deliberately not gated on showChip either. A run that ends after HEAD went
	// detached, or after the branch query failed, has lost its chip but still has
	// a failure to report; losing the spinner is acceptable, losing the error is
	// a silent failure.
	const syncError =
		!syncSheetOpen && outcome?.kind === "error" ? outcome : null;

	return (
		<>
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
					<SyncChip
						sync={sync}
						running={running}
						onClick={() => setSheet("sync")}
					/>
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
					<SyncSheet sync={sync} onClose={() => setSheet(null)} />
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

			{/* Its own banner rather than a shared slot: the banner DiffTab renders
			    below this one for its inline actions is a different unacknowledged
			    failure, and hiding either of them would be hiding a failure. */}
			{syncError && (
				<ErrorBanner
					summary={syncError.summary}
					details={syncError.detail}
					onDismiss={() => gitSyncActions.dismissOutcome(worktree)}
				/>
			)}
		</>
	);
}

function headLabel(head: GitHead): string {
	return head.detached ? `detached @ ${head.hash}` : head.branch;
}

export default BranchBar;
