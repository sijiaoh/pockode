import { GitBranch } from "lucide-react";
import { useState } from "react";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { useGitBranches } from "../../hooks/useGitBranches";
import { useGitStatus } from "../../hooks/useGitStatus";
import { gitCheckoutActions, useCheckoutRun } from "../../lib/gitCheckoutStore";
import { rebasingBranch } from "../../lib/gitOperation";
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
	/**
	 * Whether the list under the bar is the Branches list, which pins the
	 * branch failures itself; under any other list they are shown here.
	 */
	branchFailureSurface: boolean;
	/** Its failure follows the same rule as a switch's. */
	mergeHandoff: Pick<BranchMergeHandoff, "error" | "dismissError">;
}

/**
 * The top row of the Git workspace's lists: which branch this worktree is on,
 * and the sync chip. A narrow detail layer goes without it; what it reports is
 * kept until the user is back on a list.
 *
 * The name is not pressable: the segment control right under the bar is the
 * way to Branches, and the bar names and reports rather than navigates.
 *
 * It renders outside the lists' loading/error branches on purpose — a failing
 * git.status must not take branch identity down with it.
 */
function BranchBar({ branchFailureSurface, mergeHandoff }: Props) {
	const { data: branches, isLoading, error } = useGitBranches();
	const [syncSheetOpen, setSyncSheetOpen] = useState(false);
	const worktree = useWorktreeStore((s) => s.current);
	const run = useSyncRun(worktree);
	const { outcome } = run;
	const checkoutRun = useCheckoutRun(worktree);
	// A rebase detaches HEAD: `detached @ hash` would be true and useless.
	const rebasing = rebasingBranch(useGitStatus().data?.operation);

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
	// runs: over the Branches list it is pinned there, over any other list it
	// is shown under the bar that names the branch the user is actually on.
	// One failure, in one place. The list draws it only once there are
	// branches to draw (the read failed with nothing cached leaves it only that
	// failure), so then it is shown here.
	const listHoldsFailures = branchFailureSurface && Boolean(branches);
	const checkoutError = listHoldsFailures ? null : checkoutRun.error;
	// A delete's failure follows the same rule: its confirm closes when the
	// user navigates away, and the request keeps running.
	const deleteError = listHoldsFailures ? null : checkoutRun.deleteError;
	// And a merge handoff's: the user can move to another segment while its
	// new session is being created.
	const handoffError = listHoldsFailures ? null : mergeHandoff.error;

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
					<div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-th-text-primary">
						<CurrentBranch head={head} rebasing={rebasing} />
					</div>
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
			    switch's, a branch delete's, a merge handoff's, and the one
			    ChangesSection renders further down for its inline actions are
			    different unacknowledged failures, and hiding any of them would be
			    hiding a failure. */}
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
			{deleteError && (
				<ErrorBanner
					summary={deleteError.summary}
					details={deleteError.detail}
					onDismiss={() => gitCheckoutActions.dismissDeleteError(worktree)}
				/>
			)}
			{handoffError && (
				<ErrorBanner
					summary={handoffError.summary}
					details={handoffError.detail}
					onDismiss={mergeHandoff.dismissError}
				/>
			)}
		</>
	);
}

/**
 * The branch icon and HEAD's name, as plain text: the top bar and the
 * sidebar's overview name the branch the same way. Each caller keeps its own
 * row around it.
 */
export function CurrentBranch({
	head,
	rebasing,
}: {
	head: GitHead;
	rebasing: string | null;
}) {
	return (
		<>
			<GitBranch
				className="h-4 w-4 shrink-0 text-th-text-muted"
				aria-hidden="true"
			/>
			<span className="sr-only">Current branch: </span>
			<HeadName head={head} rebasing={rebasing} />
		</>
	);
}

/** HEAD's name, or the branch a rebase is rewriting while it runs. */
function HeadName({
	head,
	rebasing,
}: {
	head: GitHead;
	rebasing: string | null;
}) {
	return rebasing ? (
		<BranchName name={rebasing} suffix="· rebasing" />
	) : (
		<BranchName name={headLabel(head)} />
	);
}

export function headLabel(head: GitHead): string {
	return head.detached ? `detached @ ${head.hash}` : head.branch;
}

export default BranchBar;
