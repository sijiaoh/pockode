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
import { formatDateTime } from "../../utils/dateTime";
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
 * (docs/git-history-ui.md#the-history-segment). From the list's
 * `@git-commit-row` width on, one line instead: the refs and subject, then
 * author, age and hash as columns anchored to the right. The two layouts are
 * separate markup, so the narrow one stays exactly as it was.
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
	const limit = chipLimit(textWidth);
	const color = graph ? lineColor(graph.line) : "currentColor";
	const chipWidth = textWidth < TWO_CHIP_TEXT_WIDTH ? "narrow" : "wide";
	const age = formatRelativeDate(commit.date);
	const when = formatDateTime(commit.date);

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
				className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left @git-commit-row:pr-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
			>
				{graph ? (
					<CommitGraphCell row={graph} cap={cap} width={graphWidth} dot={dot} />
				) : (
					<LoneDotCell dot={dot} />
				)}
				<span className="min-w-0 flex-1 @git-commit-row:hidden">
					<span
						className="block truncate text-sm text-th-text-primary"
						title={commit.subject}
					>
						{commit.subject}
					</span>
					<span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-th-text-muted">
						<RefChips
							chips={chips}
							limit={limit}
							color={color}
							width={chipWidth}
						/>
						<span className="shrink-0 font-mono">
							{commit.hash.substring(0, 7)}
						</span>
						<span
							className="min-w-0 truncate"
							title={`${commit.author}, ${when}`}
						>
							{commit.author}, {age}
						</span>
					</span>
				</span>
				<span className="hidden min-w-0 flex-1 items-center gap-1.5 text-xs leading-4 @git-commit-row:flex">
					<RefChips
						chips={chips}
						limit={limit}
						color={color}
						width={chipWidth}
					/>
					{/* The floor the graph already keeps the text column at:
					    crowded chips give way before the subject does. */}
					<span
						className="min-w-40 flex-1 basis-0 truncate text-sm leading-5 text-th-text-primary"
						title={commit.subject}
					>
						{commit.subject}
					</span>
				</span>
				<span
					className="ml-2 hidden w-32 shrink-0 truncate text-xs text-th-text-muted @git-commit-row:block"
					title={commit.author}
				>
					{commit.author}
				</span>
				<span
					className="ml-2 hidden w-16 shrink-0 text-right text-xs text-th-text-muted @git-commit-row:block"
					title={when}
				>
					{age}
				</span>
				<span
					className="ml-2 hidden shrink-0 font-mono text-xs text-th-text-muted @git-commit-row:block"
					title={commit.hash}
				>
					{commit.hash.substring(0, 7)}
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
