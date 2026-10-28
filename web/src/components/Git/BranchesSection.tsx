import { ConfirmDialog } from "@pockode/shared";
import { Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import {
	useGitBranchActions,
	useGitBranches,
} from "../../hooks/useGitBranches";
import { useGitStatus } from "../../hooks/useGitStatus";
import {
	describeBranchDelete,
	describeMergePrompt,
	findBranchRow,
} from "../../lib/gitBranches";
import { branchSwitchPausedReason } from "../../lib/gitOperation";
import type { GitBranchInspection } from "../../types/git";
import { BottomActionBar, Spinner } from "../ui";
import { headLabel } from "./BranchBar";
import BranchList, { hasMenu, useBranchCheckout } from "./BranchList";
import BranchMenu from "./BranchMenu";
import NewBranchSheet from "./NewBranchSheet";

/**
 * The Git workspace's Branches segment: the branch list as a page, with the
 * way to a new branch fixed under it.
 *
 * A switch that succeeds stays here — the check moves to the new branch and
 * the name in the top bar changes, which is the whole report of it. A delete
 * that succeeds is reported by its row going. A merge is never run here: it
 * is handed to the agent, which can get through the conflicts it stops on.
 */
function BranchesSection({
	mergeHandoff,
}: {
	/** The workspace's, so that it outlives this segment. */
	mergeHandoff: BranchMergeHandoff;
}) {
	const { data: branches, isLoading, error } = useGitBranches();
	const { checkoutMutation, createMutation, deleteMutation } =
		useGitBranchActions();
	const checkout = useBranchCheckout(
		async (branch) => {
			await checkoutMutation.mutateAsync(branch);
		},
		async (name, tip) => {
			await deleteMutation.mutateAsync({ name, tip });
		},
	);
	const [creating, setCreating] = useState(false);
	// The key, not the row: the list refreshes under an open menu, and a row
	// that became occupied, current or gone must not keep offering Delete.
	const [menuKey, setMenuKey] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<{
		name: string;
		inspection: GitBranchInspection;
	} | null>(null);
	const { handingOff } = mergeHandoff;
	const pausedId = useId();

	const menuRow = useMemo(() => {
		if (!menuKey || !branches) return null;
		const row = findBranchRow(branches, menuKey);
		return row && hasMenu(row) ? row : null;
	}, [branches, menuKey]);
	// Closed for good rather than hidden, so a branch of the same name created
	// later does not bring the sheet back.
	if (menuKey && branches && !menuRow) setMenuKey(null);

	const head = branches?.head;
	const isSwitching = checkout.switchingTo !== null;
	const operation = useGitStatus().data?.operation;
	const paused = operation ? branchSwitchPausedReason(operation.kind) : null;

	return (
		<>
			{/* No vertical padding of its own: the list pins its filter and its
			    refusals to the top of this scroller. */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{/* Data first, as in the top bar: a refetch that fails leaves the
				    branches already known. */}
				{branches ? (
					<BranchList
						branches={branches}
						state={checkout}
						paused={paused}
						pausedId={pausedId}
						handingOff={handingOff}
						handoffError={mergeHandoff.error}
						onDismissHandoffError={mergeHandoff.dismissError}
						onOpenMenu={(row) => setMenuKey(row.key)}
					/>
				) : isLoading ? (
					<div className="flex items-center justify-center p-8">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				) : (
					error && (
						<div className="p-4 text-center text-th-error">
							<div>Failed to load branches</div>
							<div className="mt-1 text-sm text-th-text-muted">
								{error instanceof Error ? error.message : String(error)}
							</div>
						</div>
					)
				)}
			</div>

			{head && (
				<BottomActionBar>
					<button
						type="button"
						onClick={() => setCreating(true)}
						disabled={isSwitching || handingOff !== null || paused !== null}
						aria-describedby={paused ? pausedId : undefined}
						className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						<Plus className="h-4 w-4" aria-hidden="true" />
						New branch…
					</button>
				</BottomActionBar>
			)}

			{creating && head && (
				<NewBranchSheet
					base={headLabel(head)}
					paused={paused}
					onClose={() => setCreating(false)}
					onCreate={async (name) => {
						await createMutation.mutateAsync(name);
						setCreating(false);
					}}
				/>
			)}

			{menuRow && head && (
				<BranchMenu
					row={menuRow}
					head={head}
					operation={operation?.kind ?? null}
					switching={isSwitching}
					deleting={checkout.deleting}
					handingOff={handingOff !== null}
					onClose={() => setMenuKey(null)}
					onMerge={() => {
						// From the branches this render holds, not from the row the
						// sheet was opened on. Never null here: a detached HEAD has
						// disabled the item already.
						const text = branches && describeMergePrompt(menuRow, branches);
						if (!text) return;
						setMenuKey(null);
						mergeHandoff.start(menuRow.key, text);
					}}
					onDelete={(inspection) => {
						setMenuKey(null);
						setPendingDelete({ name: menuRow.name, inspection });
					}}
				/>
			)}

			{pendingDelete && (
				<BranchDeleteConfirm
					name={pendingDelete.name}
					inspection={pendingDelete.inspection}
					onConfirm={async () => {
						// Settles either way; a failure is pinned above the list.
						await checkout.deleteBranch(
							pendingDelete.name,
							pendingDelete.inspection.tip,
						);
						setPendingDelete(null);
					}}
					onCancel={() => setPendingDelete(null)}
				/>
			)}
		</>
	);
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

export default BranchesSection;
