import { Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	type BranchRow,
	branchDeleteUnavailableReason,
	branchMergeUnavailableReason,
} from "../../lib/gitBranches";
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
import { Sheet } from "../ui";
import ErrorBanner from "./ErrorBanner";

interface Props {
	row: BranchRow;
	head: GitHead;
	operation: GitOperationKind | null;
	switching: boolean;
	/** The branch whose delete is running, null when none is. */
	deleting: string | null;
	/** A merge handoff is waiting for its new session. */
	handingOff: boolean;
	onClose: () => void;
	/**
	 * Hand the merge of the row's branch to the agent. The caller owns the
	 * handoff and closes this sheet: its pending state and failure have to
	 * outlive it.
	 */
	onMerge: () => void;
	/**
	 * The cost of deleting the row's branch has been read. The caller closes
	 * this sheet and opens the confirm: sheets do not nest, and a dialog over a
	 * sheet would be two dismissals for one decision.
	 */
	onDelete: (inspection: GitBranchInspection) => void;
}

/**
 * What a branch's `⋯` offers beyond switching to it, which tapping the row
 * already does (docs/git-branches-ui.md#the-branchs-menu-). A sheet on both
 * layouts, in `ChangedFileMenu`'s order: the destructive row last, behind a
 * divider.
 */
function BranchMenu({
	row,
	head,
	operation,
	switching,
	deleting,
	handingOff,
	onClose,
	onMerge,
	onDelete,
}: Props) {
	const inspectBranch = useWSStore((s) => s.actions.inspectBranch);
	const [inspecting, setInspecting] = useState(false);
	const [error, setError] = useState<GitFailure | null>(null);
	// A sheet dismissed while the inspect runs is the user changing their
	// mind: the confirm must not pop up after it.
	const open = useRef(true);
	useEffect(() => {
		open.current = true;
		return () => {
			open.current = false;
		};
	}, []);

	const mergeUnavailable = branchMergeUnavailableReason(head, {
		operation,
		switching,
		// A remote row is never the one being deleted, even of the same name.
		deleting: !row.remote && deleting === row.name,
		handingOff,
	});
	const deleteUnavailable = branchDeleteUnavailableReason(row, {
		operation,
		switching,
		deleting: deleting !== null,
	});

	const inspect = async () => {
		if (inspecting) return;
		setInspecting(true);
		setError(null);
		try {
			const inspection = await inspectBranch(row.name);
			if (open.current) onDelete(inspection);
		} catch (err) {
			if (!open.current) return;
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
		<Sheet title={row.label} onClose={onClose}>
			{error && (
				<ErrorBanner
					summary={error.summary}
					details={error.detail}
					onDismiss={() => setError(null)}
				/>
			)}
			<div className="py-1">
				<MenuRow
					icon={Sparkles}
					label="Ask AI to merge into current branch"
					disabled={mergeUnavailable !== null}
					description={mergeUnavailable ?? undefined}
					onClick={onMerge}
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
		</Sheet>
	);
}

export default BranchMenu;
