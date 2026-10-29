import { Plus } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import {
	useGitBranchActions,
	useGitBranches,
} from "../../hooks/useGitBranches";
import { type BranchRow, findBranchRow } from "../../lib/gitBranches";
import { branchSwitchPausedReason } from "../../lib/gitOperation";
import { BottomActionBar, Spinner } from "../ui";
import { PinnedBranchFailures, useBranchActions } from "./BranchActions";
import { headLabel } from "./BranchBar";
import BranchList, { hasMenu } from "./BranchList";
import BranchMenu from "./BranchMenu";
import NewBranchSheet from "./NewBranchSheet";
import { useRevealLitRow } from "./revealRow";

/**
 * The Git workspace's Branches segment: the branch list as a page, with the
 * way to a new branch fixed under it.
 *
 * A row opens its branch's detail; the `⋯` beside it is the quick path to the
 * detail's actions. A switch that succeeds stays here — the check moves to the
 * new branch and the name in the top bar changes, which is the whole report of
 * it. A delete that succeeds is reported by its row going. A merge is never
 * run here: it is handed to the agent, which can get through the conflicts it
 * stops on.
 */
function BranchesSection({
	mergeHandoff,
	activeKey,
	reveal,
	onSelectBranch,
	onBranchDeleted,
}: {
	/** The app's, so that it outlives this segment. */
	mergeHandoff: BranchMergeHandoff;
	/** The key of the branch whose detail is open beside the list. */
	activeKey: string | null;
	/** Set while the lit row is wanted on screen; called once it is. */
	reveal?: () => void;
	onSelectBranch: (row: BranchRow) => void;
	onBranchDeleted: (row: BranchRow) => void;
}) {
	const { data: branches, isLoading, error } = useGitBranches();
	const { createMutation } = useGitBranchActions();
	const actions = useBranchActions(mergeHandoff, onBranchDeleted);
	const { checkout, operation, handingOff } = actions;
	const [creating, setCreating] = useState(false);
	// The key, not the row: the list refreshes under an open menu, and a row
	// that became occupied, current or gone must not keep offering Delete.
	const [menuKey, setMenuKey] = useState<string | null>(null);
	const pausedId = useId();
	const scrollerRef = useRef<HTMLDivElement>(null);
	useRevealLitRow(scrollerRef, reveal);

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
	const paused = operation ? branchSwitchPausedReason(operation) : null;

	return (
		<>
			{/* No vertical padding of its own: the list pins its filter and its
			    refusals to the top of this scroller. The container its rows lay
			    out by, so they follow the list's width, not the window's. */}
			<div
				ref={scrollerRef}
				className="@container min-h-0 flex-1 overflow-y-auto"
			>
				{/* Data first, as in the top bar: a refetch that fails leaves the
				    branches already known. */}
				{branches ? (
					<BranchList
						branches={branches}
						switchingTo={checkout.switchingTo}
						paused={paused}
						pausedId={pausedId}
						handingOff={handingOff}
						failures={
							<PinnedBranchFailures
								checkout={checkout}
								handoff={mergeHandoff}
							/>
						}
						activeKey={activeKey}
						onSelect={onSelectBranch}
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
						className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-offset-2 focus-visible:ring-offset-th-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
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
						await createMutation.mutateAsync({ name });
						setCreating(false);
					}}
				/>
			)}

			{menuRow && head && (
				<BranchMenu
					row={menuRow}
					head={head}
					actions={actions}
					onClose={() => setMenuKey(null)}
				/>
			)}

			{actions.dialog}
		</>
	);
}

export default BranchesSection;
