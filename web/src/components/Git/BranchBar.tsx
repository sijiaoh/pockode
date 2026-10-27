import { GitBranch } from "lucide-react";
import { useState } from "react";
import { useGitBranches } from "../../hooks/useGitBranches";
import { gitCheckoutActions, useCheckoutRun } from "../../lib/gitCheckoutStore";
import { gitSyncActions, useSyncRun } from "../../lib/gitSyncStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { GitHead } from "../../types/git";
import { describeSyncStatus, hasSyncStatus } from "../../utils/gitSyncStatus";
import BranchName from "./BranchName";
import ErrorBanner from "./ErrorBanner";
import HeadPlaceholder from "./HeadPlaceholder";
import SyncChip from "./SyncChip";
import SyncSheet from "./SyncSheet";

interface Props {
	/** Where the branch name leads: the workspace's Branches segment. */
	onOpenBranches: () => void;
	/**
	 * Whether the Branches segment is on screen, holding a switch's failure in
	 * its own pinned area; when it is not, the failure is shown here.
	 */
	branchesOnScreen: boolean;
}

/**
 * The fixed top row of the Git workspace: which branch this worktree is on,
 * the way to the branch list, and the sync chip.
 *
 * It renders outside the lists' loading/error branches on purpose — a failing
 * git.status must not take branch identity down with it.
 */
function BranchBar({ onOpenBranches, branchesOnScreen }: Props) {
	const { data: branches, isLoading, error } = useGitBranches();
	const [syncSheetOpen, setSyncSheetOpen] = useState(false);
	const worktree = useWorktreeStore((s) => s.current);
	const run = useSyncRun(worktree);
	const { outcome } = run;
	const checkoutRun = useCheckoutRun(worktree);

	const head = branches?.head;
	const sync = branches?.sync;
	const showChip = hasSyncStatus(head, sync);

	// A sync failure belongs in the sheet whenever the sheet is on screen, and
	// under the bar whenever it is not — one outcome, shown wherever the user is.
	// The test is whether the sheet actually renders, not whether it was opened:
	// without `sync` there is no sheet to hold the message.
	const syncSheetShown = syncSheetOpen && Boolean(sync);
	// Deliberately not gated on showChip either. A run that ends after HEAD went
	// detached, or after the branch query failed, has lost its chip but still has
	// a failure to report; losing the spinner is acceptable, losing the error is
	// a silent failure.
	// An automatic fetch's failure is the exception: nobody asked for that run,
	// so it is marked on the chip and explained in the sheet, never a banner.
	// Hiding the chip hides the mark, and with it nothing: the mark says the
	// counts are stale, and without the chip there are no counts on screen. The
	// outcome stays in the store, so the mark is back with the chip.
	const syncError =
		!syncSheetShown && outcome?.kind === "error" && !run.auto ? outcome : null;
	// The same rule for a branch switch, which can be walked away from while it
	// runs: on the Branches segment it is shown where the switch was asked for,
	// anywhere else in the workspace it is shown under the bar that names the
	// branch the user is actually on. One failure, in one place. The segment's
	// pinned area lives inside the list, so a segment with no branches to list
	// (the read failed with nothing cached) cannot hold it either.
	const checkoutError = branchesOnScreen && branches ? null : checkoutRun.error;

	return (
		<>
			<div className="flex min-h-[44px] shrink-0 items-center gap-1 border-b border-th-border px-2">
				{/*
				 * Data first: a background refetch that fails still leaves the branch
				 * name we already have, and replacing it with an error would take the
				 * bar down for exactly the reason it renders outside the lists' error
				 * branches in the first place.
				 */}
				{!head ? (
					<HeadPlaceholder isLoading={isLoading} error={error} />
				) : (
					<button
						type="button"
						onClick={onOpenBranches}
						className="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 rounded px-2 text-th-text-primary pointer-coarse:min-h-11 transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						// It opens a page of branches rather than a sheet to switch in,
						// and says so.
						aria-label={`Branches, currently on ${headLabel(head)}`}
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
						status={describeSyncStatus(sync, run)}
						onClick={() => setSyncSheetOpen(true)}
					/>
				)}

				{syncSheetShown && sync && (
					<SyncSheet sync={sync} onClose={() => setSyncSheetOpen(false)} />
				)}
			</div>

			{/* A banner each rather than a shared slot: a sync's failure, a
			    switch's, and the one ChangesSection renders further down for its
			    inline actions are different unacknowledged failures, and hiding
			    any of them would be hiding a failure. */}
			{syncError && (
				<ErrorBanner
					summary={syncError.summary}
					details={syncError.detail}
					onDismiss={() => gitSyncActions.dismissOutcome(worktree)}
				/>
			)}
			{checkoutError && (
				<ErrorBanner
					summary={checkoutError.summary}
					details={checkoutError.detail}
					onDismiss={() => gitCheckoutActions.dismissError(worktree)}
				/>
			)}
		</>
	);
}

export function headLabel(head: GitHead): string {
	return head.detached ? `detached @ ${head.hash}` : head.branch;
}

export default BranchBar;
