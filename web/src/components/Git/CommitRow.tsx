import { MoreHorizontal } from "lucide-react";
import { memo } from "react";
import type { HistoryRow } from "../../hooks/useHistoryGraph";
import {
	chipLimit,
	describeCommitRow,
	lineColor,
	refChips,
	TWO_CHIP_TEXT_WIDTH,
} from "../../lib/commitHistory";
import { formatRelativeDate } from "../../utils/relativeTime";
import { iconButtonClass } from "../ui/iconButtonClass";
import CommitGraphCell, { LoneDotCell } from "./CommitGraphCell";
import RefChips from "./RefChips";

interface Props {
	row: HistoryRow;
	/** Lanes drawn before the `+N` slot. */
	cap: number;
	graphWidth: number;
	textWidth: number;
	isActive: boolean;
	onSelect: (hash: string) => void;
	onOpenMenu: (row: HistoryRow) => void;
}

/**
 * One commit of the History list: 52px, the graph, the subject on a line of
 * its own, and the refs, hash, author and age under it
 * (docs/git-history-ui.md#the-history-segment).
 *
 * No gap and no rounding between rows, unlike `SidebarListItem`'s list: a gap
 * would cut every line.
 */
function CommitRow({
	row,
	cap,
	graphWidth,
	textWidth,
	isActive,
	onSelect,
	onOpenMenu,
}: Props) {
	const { commit, graph } = row;
	const dot = {
		unpushed: commit.unpushed === true,
		merge: commit.parents.length > 1,
	};
	const chips = refChips(commit.refs);

	return (
		<div
			className={`group relative flex h-full items-center ${
				isActive
					? "bg-th-bg-tertiary before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-th-accent"
					: "hover:bg-th-bg-tertiary"
			}`}
		>
			<button
				type="button"
				onClick={() => onSelect(commit.hash)}
				// The commit open beside the list, or under it.
				aria-current={isActive ? "true" : undefined}
				aria-label={describeCommitRow(commit, {
					laneHidden: graph !== undefined && graph.lane >= cap,
				})}
				className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
			>
				{graph ? (
					<CommitGraphCell row={graph} cap={cap} width={graphWidth} dot={dot} />
				) : (
					<LoneDotCell dot={dot} />
				)}
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm text-th-text-primary">
						{commit.subject}
					</span>
					<span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-th-text-muted">
						<RefChips
							chips={chips}
							limit={chipLimit(textWidth)}
							color={graph ? lineColor(graph.line) : "currentColor"}
							width={textWidth < TWO_CHIP_TEXT_WIDTH ? "narrow" : "wide"}
						/>
						<span className="shrink-0 font-mono">
							{commit.hash.substring(0, 7)}
						</span>
						<span className="min-w-0 truncate">
							{commit.author}, {formatRelativeDate(commit.date)}
						</span>
					</span>
				</span>
			</button>
			{/* As wide as the lane cap counts it: `MENU_WIDTH`. */}
			<div className="flex w-9 shrink-0 items-center justify-center pointer-coarse:w-11">
				<button
					type="button"
					onClick={() => onOpenMenu(row)}
					aria-label={`Actions for commit ${commit.hash.substring(0, 7)}`}
					className={iconButtonClass()}
				>
					<MoreHorizontal className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}

export default memo(CommitRow);
