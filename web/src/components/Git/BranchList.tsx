import { Check, Ellipsis } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
	type BranchRow,
	branchDetails,
	branchRowLabel,
	FILTER_THRESHOLD,
	groupBranches,
} from "../../lib/gitBranches";
import type { GitBranches } from "../../types/git";
import { formatRelativeDate } from "../../utils/relativeTime";
import { Spinner } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";
import { inputClass } from "../ui/inputClass";
import BranchName from "./BranchName";

/**
 * Whether a row has a `⋯`. Never the current branch's, whose every action —
 * switching to it, merging it into itself, deleting it — would be unavailable.
 */
export function hasMenu(row: BranchRow): boolean {
	return !row.current;
}

interface Props {
	branches: GitBranches;
	/** The branch a switch is running to, wherever it was pressed. */
	switchingTo: string | null;
	/**
	 * Why no branch can be switched to right now — an operation in progress —
	 * null when one can. `pausedId` names the line for the page's own
	 * `New branch…`, which stops for the same reason.
	 */
	paused: string | null;
	pausedId?: string;
	/** The key of the row whose merge handoff is waiting for a new session. */
	handingOff: string | null;
	/** The branch failures, pinned under the filter. */
	failures: ReactNode;
	/** The key of the row whose detail is open beside the list, lit. */
	activeKey: string | null;
	onSelect: (row: BranchRow) => void;
	onOpenMenu: (row: BranchRow) => void;
}

/**
 * The branches, grouped Recent / Local / Remote once the list is long
 * (docs/git-branches-ui.md#the-list), with the filter and failures pinned
 * above them. A row opens its branch; acting on it is the detail's, or the
 * `⋯`'s.
 */
function BranchList({
	branches,
	switchingTo,
	paused,
	pausedId,
	handingOff,
	failures,
	activeKey,
	onSelect,
	onOpenMenu,
}: Props) {
	const [filter, setFilter] = useState("");
	const filterId = useId();

	const groups = useMemo(
		() => groupBranches(branches, filter),
		[branches, filter],
	);

	const showFilter =
		branches.local.length + branches.remote_only.length > FILTER_THRESHOLD;

	return (
		<>
			{/*
			 * Pinned above the rows: the list is taller than the screen whenever
			 * either of these matters. A filter that scrolls away is the way out of
			 * a long list that the user cannot reach, and a refusal that scrolls
			 * away turns a failed switch into one that simply did nothing — the
			 * user switches from a `⋯` halfway down, and the message lands off the
			 * top.
			 */}
			{/* Opaque over the rows scrolling under it. */}
			<div className="sticky top-0 z-10 bg-th-bg-primary">
				{showFilter && (
					<div className="p-3">
						<label htmlFor={filterId} className="sr-only">
							Filter branches
						</label>
						<input
							id={filterId}
							type="text"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter branches…"
							className={`w-full rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
							autoComplete="off"
						/>
					</div>
				)}

				{paused && (
					<p id={pausedId} className="px-4 py-3 text-sm text-th-text-muted">
						{paused}
					</p>
				)}

				{failures}
			</div>

			{groups.length > 0 && branches.default_branch && (
				<p className="px-4 pt-2 pb-1 text-xs text-th-text-muted">
					Compared with {branches.default_branch}
				</p>
			)}

			{groups.map((group, i) => (
				<div key={group.title ?? "all"}>
					{group.title && (
						<div
							className={`px-4 pt-2 pb-1 text-xs uppercase text-th-text-muted ${
								i > 0 ? "mt-2 border-t border-th-border" : ""
							}`}
						>
							{group.title}
						</div>
					)}
					{group.rows.map((row) => (
						<BranchRowItem
							key={row.key}
							row={row}
							defaultBranch={branches.default_branch}
							active={row.key === activeKey}
							busy={
								switchingTo === row.name
									? `Switching to ${row.label}`
									: handingOff === row.key
										? "Opening a new chat"
										: null
							}
							onSelect={() => onSelect(row)}
							onOpenMenu={hasMenu(row) ? () => onOpenMenu(row) : null}
						/>
					))}
				</div>
			))}

			{groups.length === 0 && (
				<p className="px-4 py-3 text-sm text-th-text-muted">
					{filter.trim() ? "No branches match." : "No branches yet."}
				</p>
			)}
		</>
	);
}

interface RowProps {
	row: BranchRow;
	defaultBranch: string;
	active: boolean;
	/** What this row's running switch or merge handoff is doing, for the spinner. */
	busy: string | null;
	onSelect: () => void;
	/** Null where the row has no `⋯`; the slot then stays empty. */
	onOpenMenu: (() => void) | null;
}

/**
 * One branch: the row that opens it, and the slot beside it, siblings as in
 * the Changes list. The slot holds the spinner while this row's switch or
 * merge handoff runs and the row's `⋯` otherwise, and is left empty on a row
 * with no menu, so names line up.
 *
 * Never disabled, whatever runs: opening a branch writes nothing, so there is
 * nothing for a switch or a handoff to collide with. What a held branch cannot
 * do is said by its state word, and by its actions.
 */
function BranchRowItem({
	row,
	defaultBranch,
	active,
	busy,
	onSelect,
	onOpenMenu,
}: RowProps) {
	const age = formatRelativeDate(row.committed_at);

	return (
		// History's active treatment (CommitRow): the fill across the row and
		// the accent bar at its left edge, beside the gutter's check.
		<div
			className={`relative flex min-h-[52px] items-center ${
				active
					? "bg-th-bg-tertiary before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-th-accent"
					: ""
			}`}
		>
			<button
				type="button"
				onClick={onSelect}
				aria-label={branchRowLabel(row, defaultBranch, age)}
				aria-current={active ? "true" : undefined}
				className="flex min-w-0 flex-1 items-center gap-2 self-stretch py-1.5 pl-4 text-left text-th-text-primary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
			>
				{row.current ? (
					<Check
						className="h-4 w-4 shrink-0 text-th-success"
						aria-hidden="true"
					/>
				) : (
					<span className="h-4 w-4 shrink-0" />
				)}
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="flex min-w-0">
						<BranchName name={row.label} />
					</span>
					<span className="flex min-w-0 gap-2 text-xs text-th-text-muted">
						{/* Cut at the tail: the state word leads, and `in <worktree>`
						    is why the branch cannot be switched to here. */}
						<span className="min-w-0 flex-1 truncate">
							{branchDetails(row).join(" · ")}
						</span>
						<span className="shrink-0">{age}</span>
					</span>
				</span>
			</button>
			<span className="flex h-11 w-11 shrink-0 items-center justify-center text-th-text-muted">
				{busy ? (
					<Spinner variant="current" srText={busy} />
				) : (
					onOpenMenu && (
						<button
							type="button"
							onClick={onOpenMenu}
							aria-label={`More actions for ${row.label}`}
							className={iconButtonClass()}
						>
							<Ellipsis className="h-4 w-4" aria-hidden="true" />
						</button>
					)
				)}
			</span>
		</div>
	);
}

export default BranchList;
