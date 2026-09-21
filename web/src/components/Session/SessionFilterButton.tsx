import { useIsExpanded } from "@pockode/shared";
import { Archive, GitBranch, ListFilter } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSessionViewSources } from "../../hooks/sessionViewQueries";
import { useWorktreeList } from "../../hooks/useWorktreeList";
import type { SessionViewWorktree } from "../../lib/rpc/sessionView";
import {
	CURRENT_WORKTREE_FILTER,
	type SessionFilter,
} from "../../lib/sessionFilter";
import { useSessionStore } from "../../lib/sessionStore";
import { describeWorktree } from "../../lib/sessionView";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { WorktreeInfo } from "../../types/message";
import { BadgeDot } from "../ui";
import ResponsivePanel from "../ui/ResponsivePanel";
import FilterOption from "./FilterOption";

interface Props {
	disabled?: boolean;
}

/** One choosable worktree, as the panel draws it. */
interface WorktreeChoice {
	worktree: string;
	label: string;
	exists: boolean;
	count: number;
}

export default function SessionFilterButton({ disabled }: Props) {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const isExpanded = useIsExpanded();

	const showTaskSessions = useSessionStore((s) => s.showTaskSessions);
	const toggleShow = useSessionStore((s) => s.toggleShowTaskSessions);
	const filter = useSessionStore((s) => s.worktreeFilter);
	const setFilter = useSessionStore((s) => s.setWorktreeFilter);
	const currentWorktree = useWorktreeStore((s) => s.current);

	// Asked for while the panel is open, and while the answer is already on
	// screen as somebody else's list. A single-worktree machine never asks.
	const { sources } = useSessionViewSources(
		isOpen || filter.kind !== "current",
	);
	const worktrees = useWorktreeList();

	const choices = useMemo(
		() => toChoices(sources, currentWorktree, worktrees),
		[sources, currentWorktree, worktrees],
	);

	const handleClose = useCallback(() => setIsOpen(false), []);
	const handleToggle = useCallback(() => setIsOpen((v) => !v), []);

	// Picking a worktree closes the panel; the checkbox above it does not. A
	// choice among several is over once it is made, and on a phone this panel is
	// a sheet over the very list the choice changed — leaving it up would hide
	// the only answer the user asked for. A toggle is not over: it is flipped,
	// looked at, and often flipped back.
	const choose = useCallback(
		(next: SessionFilter) => {
			setFilter(next);
			setIsOpen(false);
		},
		[setFilter],
	);

	const existing = choices.filter((c) => c.exists);
	const deleted = choices.filter((c) => !c.exists);
	const selected = choices.find(
		(c) => filter.kind === "worktree" && c.worktree === filter.worktree,
	);

	return (
		<div className="relative">
			<button
				ref={triggerRef}
				type="button"
				onClick={handleToggle}
				disabled={disabled}
				className="relative flex items-center justify-center rounded-md border min-h-[44px] min-w-[44px] p-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 border-th-border bg-th-bg-tertiary text-th-text-secondary hover:border-th-border-focus hover:text-th-text-primary disabled:cursor-not-allowed disabled:opacity-50"
				aria-label={triggerLabel(filter, selected?.label)}
				aria-expanded={isOpen}
			>
				<ListFilter className="h-5 w-5" aria-hidden="true" />
				{/* The filter is not persisted, so nothing else on screen says the
				    list is somebody else's once the panel is closed. */}
				<BadgeDot
					show={filter.kind !== "current"}
					className="top-1.5 right-1.5"
				/>
			</button>

			<ResponsivePanel
				isOpen={isOpen}
				onClose={handleClose}
				title="Filter sessions"
				triggerRef={triggerRef}
				isExpanded={isExpanded}
				desktopPosition="right"
				mobileMaxHeight="50dvh"
			>
				{/* The panel caps its own height and clips, so the one thing in it
				    that grows — a machine's worth of worktrees — needs a scroller of
				    its own, or the last of them cannot be reached
				    (the same one `WorktreeDropdown` gives its list). */}
				<div className="flex-1 overflow-y-auto">
					<div className="py-2">
						<FilterOption
							label="Show task sessions"
							description="Include sessions linked to tasks in the list"
							checked={showTaskSessions}
							onChange={toggleShow}
						/>
					</div>

					{/* Left out entirely while this is the only worktree with sessions:
				    a choice between one place and all of it is not a choice. Not
				    while a choice is in force, though — the rows are the only way
				    back from one, and the last of them can go while it is
				    selected. */}
					{(choices.length > 0 || filter.kind !== "current") && (
						// One group for both headings: they separate deleted worktrees
						// from live ones visually, and splitting the radio group along
						// them would split one choice into two.
						<div
							className="border-t border-th-border py-2"
							role="radiogroup"
							aria-label="Filter sessions by worktree"
						>
							<GroupHeader>Worktrees</GroupHeader>
							<FilterOption
								type="radio"
								name="session-worktree-filter"
								label="This worktree"
								checked={filter.kind === "current"}
								onChange={() => choose(CURRENT_WORKTREE_FILTER)}
							/>
							<FilterOption
								type="radio"
								name="session-worktree-filter"
								label="All worktrees"
								checked={filter.kind === "all"}
								onChange={() => choose({ kind: "all" })}
							/>
							{existing.map((choice) => (
								<WorktreeChoiceRow
									key={choice.worktree}
									choice={choice}
									filter={filter}
									onSelect={choose}
								/>
							))}
							{deleted.length > 0 && (
								<>
									<GroupHeader>Deleted</GroupHeader>
									{deleted.map((choice) => (
										<WorktreeChoiceRow
											key={choice.worktree}
											choice={choice}
											filter={filter}
											onSelect={choose}
										/>
									))}
								</>
							)}
						</div>
					)}
				</div>
			</ResponsivePanel>
		</div>
	);
}

function GroupHeader({ children }: { children: string }) {
	return (
		<div className="flex min-h-[32px] items-center px-4 text-xs uppercase tracking-wide text-th-text-muted">
			{children}
		</div>
	);
}

function WorktreeChoiceRow({
	choice,
	filter,
	onSelect,
}: {
	choice: WorktreeChoice;
	filter: SessionFilter;
	onSelect: (filter: SessionFilter) => void;
}) {
	// Two glyphs rather than the word "(deleted)": a 240px row has no space for
	// it, and `Archive` says the thing that has to be said — kept, but no longer
	// running. The word is there for a screen reader, which has the room.
	const Icon = choice.exists ? GitBranch : Archive;
	return (
		<FilterOption
			type="radio"
			name="session-worktree-filter"
			checked={
				filter.kind === "worktree" && filter.worktree === choice.worktree
			}
			onChange={() => onSelect({ kind: "worktree", worktree: choice.worktree })}
			icon={
				<Icon
					className="size-3.5 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
			}
			label={
				<>
					{choice.label}
					{!choice.exists && (
						<span className="sr-only">, deleted worktree</span>
					)}
				</>
			}
			// Not decoration: it is the only warning the user gets that deleting
			// the last session takes this worktree out of the filter for good.
			// Said in words for a screen reader, which would otherwise be read a
			// bare number at the end of the row's name.
			trailing={
				<>
					<span aria-hidden="true">{choice.count}</span>
					<span className="sr-only">
						{choice.count === 1 ? "1 session" : `${choice.count} sessions`}
					</span>
				</>
			}
		/>
	);
}

/**
 * The worktrees worth offering: every one the server still holds sessions for,
 * except the one the user is standing in — that one is "This worktree", and
 * listing it twice would make the same list reachable two ways.
 *
 * Ordered main first and then by name, as `WorktreeDropdown` orders the same
 * worktrees: the server returns them in the order it happens to walk the disk,
 * which is no order at all to look something up in.
 */
function toChoices(
	sources: SessionViewWorktree[],
	currentWorktree: string,
	worktrees: WorktreeInfo[],
): WorktreeChoice[] {
	return sources
		.filter((source) => source.worktree !== currentWorktree)
		.map((source) => ({
			worktree: source.worktree,
			label: describeWorktree(source.worktree, worktrees).label,
			exists: source.exists,
			count: source.session_count,
		}))
		.sort((a, b) => {
			const aMain = a.worktree === "";
			if (aMain !== (b.worktree === "")) return aMain ? -1 : 1;
			return a.label.localeCompare(b.label);
		});
}

function triggerLabel(
	filter: SessionFilter,
	label: string | undefined,
): string {
	switch (filter.kind) {
		case "current":
			return "Filter sessions";
		case "all":
			return "Filter sessions, showing all worktrees";
		case "worktree":
			return `Filter sessions, showing worktree ${label ?? filter.worktree}`;
	}
}
