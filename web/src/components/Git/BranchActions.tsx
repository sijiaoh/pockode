import { ConfirmDialog } from "@pockode/shared";
import { ArrowRightLeft, Sparkles, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import {
	useGitBranchActions,
	useGitBranches,
} from "../../hooks/useGitBranches";
import { useGitStatus } from "../../hooks/useGitStatus";
import {
	type BranchRow,
	branchDeleteUnavailableReason,
	branchMergeUnavailableReason,
	branchSwitchUnavailableReason,
	describeBranchDelete,
	describeMergePrompt,
} from "../../lib/gitBranches";
import {
	type CheckoutRun,
	gitCheckoutActions,
	useCheckoutRun,
} from "../../lib/gitCheckoutStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import { useWSStore } from "../../lib/wsStore";
import type {
	GitBranchInspection,
	GitHead,
	GitOperationKind,
} from "../../types/git";
import {
	branchRefusalSummary,
	describeGitFailure,
	type GitFailure,
} from "../../utils/gitErrors";
import MenuRow from "../common/MenuRow";
import { iconButtonClass } from "../ui/iconButtonClass";
import ErrorBanner from "./ErrorBanner";
import GitOutput from "./GitOutput";

export interface BranchCheckout extends CheckoutRun {
	checkout: (branch: string) => void;
	dismissError: () => void;
	/**
	 * Resolves once the delete settles, to whether the branch was deleted; see
	 * startDelete.
	 */
	deleteBranch: (branch: string, tip: string) => Promise<boolean>;
	dismissDeleteError: () => void;
}

/**
 * This worktree's switch and delete and how they ended. The runs themselves
 * are gitCheckoutStore's, so they outlive the page that started them.
 */
function useBranchCheckout(): BranchCheckout {
	const worktree = useWorktreeStore((s) => s.current);
	const run = useCheckoutRun(worktree);
	const { checkoutMutation, deleteMutation } = useGitBranchActions();

	return {
		...run,
		checkout: (branch) =>
			void gitCheckoutActions.start(worktree, branch, () =>
				checkoutMutation.mutateAsync(branch),
			),
		dismissError: () => gitCheckoutActions.dismissError(worktree),
		deleteBranch: (branch, tip) =>
			gitCheckoutActions.startDelete(worktree, branch, () =>
				deleteMutation.mutateAsync({ name: branch, tip }),
			),
		dismissDeleteError: () => gitCheckoutActions.dismissDeleteError(worktree),
	};
}

export interface BranchActions {
	checkout: BranchCheckout;
	operation: GitOperationKind | null;
	/** The key of the row whose merge handoff waits for a new chat. */
	handingOff: string | null;
	switchTo: (row: BranchRow) => void;
	merge: (row: BranchRow) => void;
	/** The cost of deleting `row` has been read: ask before deleting it. */
	requestDelete: (row: BranchRow, inspection: GitBranchInspection) => void;
	/** The delete's confirm, while one is asked; the caller renders it. */
	dialog: ReactNode;
}

/**
 * What a branch offers — switch, merge handoff, delete — for the two surfaces
 * that offer it: the list's `⋯` and the branch's detail
 * (docs/git-branches-ui.md#the-branchs-menu-). Both read the same runs, so a
 * switch pressed in one holds the other.
 *
 * `onDeleted` hears of a delete that succeeded, so that a detail of that
 * branch can leave it — whichever surface the delete was pressed in.
 */
export function useBranchActions(
	mergeHandoff: BranchMergeHandoff,
	onDeleted: (row: BranchRow) => void,
): BranchActions {
	const { data: branches } = useGitBranches();
	const checkout = useBranchCheckout();
	const operation = useGitStatus().data?.operation?.kind ?? null;
	const [pendingDelete, setPendingDelete] = useState<{
		row: BranchRow;
		inspection: GitBranchInspection;
	} | null>(null);

	return {
		checkout,
		operation,
		handingOff: mergeHandoff.handingOff,
		switchTo: (row) => checkout.checkout(row.name),
		merge: (row) => {
			// From the branches this render holds, not from what the surface
			// rendered. Never null here: a detached HEAD has disabled the item.
			const text = branches && describeMergePrompt(row, branches);
			if (text) mergeHandoff.start(row.key, text);
		},
		requestDelete: (row, inspection) => setPendingDelete({ row, inspection }),
		dialog: pendingDelete && (
			<BranchDeleteConfirm
				name={pendingDelete.row.name}
				inspection={pendingDelete.inspection}
				onConfirm={async () => {
					// Settles either way; a failure is pinned where the branch
					// failures go.
					const deleted = await checkout.deleteBranch(
						pendingDelete.row.name,
						pendingDelete.inspection.tip,
					);
					setPendingDelete(null);
					if (deleted) onDeleted(pendingDelete.row);
				}}
				onCancel={() => setPendingDelete(null)}
			/>
		),
	};
}

function BranchDeleteConfirm({
	name,
	inspection,
	onConfirm,
	onCancel,
}: {
	name: string;
	inspection: GitBranchInspection;
	onConfirm: () => Promise<void>;
	onCancel: () => void;
}) {
	const { title, message, confirmLabel, variant } = describeBranchDelete(
		name,
		inspection,
	);

	return (
		<ConfirmDialog
			title={title}
			message={message}
			confirmLabel={confirmLabel}
			variant={variant}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
}

interface RowsProps {
	row: BranchRow;
	head: GitHead;
	actions: BranchActions;
	/**
	 * An action was taken: the menu closes on it, before the action runs, so
	 * that a confirm never opens over the sheet. The detail stays.
	 */
	onAct?: () => void;
}

/**
 * The three actions as `MenuRow`s, the same in the menu's sheet and inline in
 * the detail: labels, icons, order, the divider before the destructive one,
 * and the sentence that says why one is unavailable. Delete first reads what
 * it would lose; a failure to read it is shown above the rows.
 */
export function BranchActionRows({ row, head, actions, onAct }: RowsProps) {
	const inspectBranch = useWSStore((s) => s.actions.inspectBranch);
	const [inspecting, setInspecting] = useState(false);
	const [error, setError] = useState<GitFailure | null>(null);
	// Rows dismissed while the inspect runs — a sheet closed, a detail left —
	// are the user changing their mind: the confirm must not pop up after it.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const { checkout, operation, handingOff } = actions;
	const switching = checkout.switchingTo !== null;
	// A remote row is never the one being deleted, even of the same name.
	const deletingThis = !row.remote && checkout.deleting === row.name;

	const switchUnavailable = branchSwitchUnavailableReason(row, {
		operation,
		switching,
		deleting: deletingThis,
		handingOff: handingOff !== null,
	});
	const mergeUnavailable = branchMergeUnavailableReason(head, {
		operation,
		switching,
		deleting: deletingThis,
		handingOff: handingOff !== null,
	});
	const deleteUnavailable = branchDeleteUnavailableReason(row, {
		operation,
		switching,
		deleting: checkout.deleting !== null,
	});

	const inspect = async () => {
		if (inspecting) return;
		setInspecting(true);
		setError(null);
		try {
			const inspection = await inspectBranch(row.name);
			if (!mounted.current) return;
			setInspecting(false);
			onAct?.();
			actions.requestDelete(row, inspection);
		} catch (err) {
			if (!mounted.current) return;
			const refusal = branchRefusalSummary(err, row.name);
			setError(
				refusal
					? { summary: refusal, detail: null }
					: describeGitFailure(
							err,
							() => `Could not read what deleting ${row.name} would lose.`,
						),
			);
			setInspecting(false);
		}
	};

	return (
		<>
			{error && (
				<ErrorBanner
					summary={error.summary}
					details={error.detail}
					onDismiss={() => setError(null)}
				/>
			)}
			<div className="py-1">
				<MenuRow
					icon={ArrowRightLeft}
					label="Switch to this branch"
					disabled={switchUnavailable !== null}
					description={switchUnavailable ?? undefined}
					busy={checkout.switchingTo === row.name}
					onClick={() => {
						onAct?.();
						actions.switchTo(row);
					}}
				/>
				<MenuRow
					icon={Sparkles}
					label="Ask AI to merge into current branch"
					disabled={mergeUnavailable !== null}
					description={mergeUnavailable ?? undefined}
					busy={handingOff === row.key}
					onClick={() => {
						onAct?.();
						actions.merge(row);
					}}
				/>
				{/* Absent, not disabled, on a remote row: deleting a remote
				    branch never applies here. */}
				{!row.remote && (
					<>
						<div className="my-1 border-t border-th-border" />
						<MenuRow
							icon={Trash2}
							label="Delete branch"
							danger
							disabled={deleteUnavailable !== null}
							description={deleteUnavailable ?? undefined}
							busy={inspecting}
							onClick={() => void inspect()}
						/>
					</>
				)}
			</div>
		</>
	);
}

/**
 * The branch failures — a switch's, a delete's, a merge handoff's — in the
 * one capped box they share, on whichever surface holds them
 * (docs/git-branches-ui.md#the-pinned-area): the list's pinned area, or the
 * top of a narrow branch detail. Each its own, never merged: two failures are
 * two things the user has not acknowledged yet.
 */
export function PinnedBranchFailures({
	checkout,
	handoff,
}: {
	checkout: BranchCheckout;
	handoff: Pick<BranchMergeHandoff, "error" | "dismissError">;
}) {
	const { error, deleteError } = checkout;
	if (!error && !deleteError && !handoff.error) return null;
	// Capped, scrolling on its own: several, each with git's output, would
	// otherwise push the page off a short phone — and none is dropped to make
	// room.
	return (
		<div className="max-h-[40dvh] overflow-y-auto">
			{error && (
				<PinnedFailure failure={error} onDismiss={checkout.dismissError} />
			)}
			{deleteError && (
				<PinnedFailure
					failure={deleteError}
					onDismiss={checkout.dismissDeleteError}
				/>
			)}
			{handoff.error && (
				<PinnedFailure
					failure={handoff.error}
					onDismiss={handoff.dismissError}
				/>
			)}
		</div>
	);
}

function PinnedFailure({
	failure,
	onDismiss,
}: {
	failure: GitFailure;
	onDismiss: () => void;
}) {
	return (
		<div className="flex items-start gap-2 px-4 py-3">
			<div className="min-w-0 flex-1 space-y-1" role="alert">
				<p className="text-sm text-th-error">{failure.summary}</p>
				{/* Absent when the server refused before running git: there is
				    no output to quote, only the sentence above. */}
				{failure.detail && <GitOutput>{failure.detail}</GitOutput>}
			</div>
			{/* A page has no sheet whose closing puts the refusal away. */}
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Dismiss error"
				className={iconButtonClass()}
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</div>
	);
}
