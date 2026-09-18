import { AlertCircle, ChevronUp, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoleNameMap } from "../../hooks/useRoleNameMap";
import { type Activity, needsUser } from "../../lib/activity";
import {
	projectPanelActions,
	useProjectPanelStore,
	type WorkSegment,
} from "../../lib/projectPanelStore";
import { useWorkStore, workPagingActions } from "../../lib/workStore";
import type { WorkListItem } from "../../types/work";
import { ActivityIcon } from "../ui";
import BackToChatButton from "../ui/BackToChatButton";
import BottomActionBar from "../ui/BottomActionBar";
import ArchivePager from "./ArchivePager";
import CreateWorkSheet from "./CreateWorkSheet";
import WorkRow from "./WorkRow";

/**
 * `scrollTop` rather than `scrollTo`: the element does not need smooth
 * behaviour here, and the property is the one every environment implements.
 */
function scrollToTop(ref: React.RefObject<HTMLDivElement | null>) {
	if (ref.current) ref.current.scrollTop = 0;
}

interface Props {
	onBack: () => void;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}

/**
 * The project list: one column of the work that needs a person or is under way,
 * and a second segment holding the archive (docs/project-ui.md §2).
 *
 * Nothing here expands. A story's tasks are listed in exactly one place, the
 * story's detail page, and the only tasks that appear here are the ones nobody
 * else is coming for — which is why a group can promise that what is in it is
 * for the user to do.
 */
export default function WorkListOverlay({
	onBack,
	onOpenWorkDetail,
	onNavigateToSession,
}: Props) {
	const works = useWorkStore((s) => s.works);
	const isLoading = useWorkStore((s) => s.isLoading);
	const error = useWorkStore((s) => s.error);
	const notRunningHidden = useWorkStore((s) => s.notRunningHidden);
	const isEarlierLoading = useWorkStore((s) => s.isEarlierLoading);
	const earlierError = useWorkStore((s) => s.earlierError);
	const archive = useWorkStore((s) => s.archive);
	const archivePage = useWorkStore((s) => s.archivePage);
	const archiveCursors = useWorkStore((s) => s.archiveCursors);
	const archiveNextCursor = useWorkStore((s) => s.archiveNextCursor);
	const archiveLoaded = useWorkStore((s) => s.archiveLoaded);
	const archiveAttempt = useWorkStore((s) => s.archiveAttempt);
	const archiveError = useWorkStore((s) => s.archiveError);
	const pagingGeneration = useWorkStore((s) => s.pagingGeneration);
	const roleNameMap = useRoleNameMap();
	const segment = useProjectPanelStore((s) => s.segment);
	const [creating, setCreating] = useState(false);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	// The archive is fetched, never pushed, so the first page is asked for the
	// first time the segment is looked at — and not before: a user who never
	// opens it never pays for it.
	//
	// `pagingGeneration` is in the dependencies because a resubscribe leaves the
	// archive unloaded on purpose, and it is what says the absence belongs to a
	// subscription that can actually answer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pagingGeneration is an intentional trigger — a fresh subscription is what makes the missing first page fetchable again
	useEffect(() => {
		if (segment !== "closed" || archiveLoaded) return;
		workPagingActions.loadArchivePage(0, "");
	}, [segment, archiveLoaded, pagingGeneration]);

	// A page is a new set of rows, and reading it from the middle is not a thing
	// anyone asked for (docs/list-paging-ui.md §4.2).
	useEffect(() => {
		if (segment === "closed") scrollToTop(scrollRef);
	}, [segment]);

	const goOlder = useCallback(() => {
		if (!archiveNextCursor) return;
		scrollToTop(scrollRef);
		workPagingActions.loadArchivePage(archivePage + 1, archiveNextCursor);
	}, [archivePage, archiveNextCursor]);

	const goNewer = useCallback(() => {
		if (archivePage === 0) return;
		scrollToTop(scrollRef);
		// Walking back is handing back a cursor already used, which is what lets
		// the server stay one-directional.
		workPagingActions.loadArchivePage(
			archivePage - 1,
			archiveCursors[archivePage - 1] ?? "",
		);
	}, [archivePage, archiveCursors]);

	const handleCreated = useCallback(
		(workId: string) => {
			setCreating(false);
			onOpenWorkDetail(workId);
		},
		[onOpenWorkDetail],
	);

	// Over both lists: a story's row states `{closed}/{total} tasks` over its
	// children, and an archive page arrives with the tasks its rows speak for
	// (docs/list-paging-ui.md §2.2).
	//
	// Deduplicated by id, because the two lists genuinely overlap: a closed story
	// with a stopped task is on the archive page *and* in the `Current` segment,
	// which carries it so that its task's row can print `in: <title>`. Counted
	// twice, its own row would then claim twice the tasks it has.
	const known = useMemo(() => {
		const byId = new Map<string, WorkListItem>();
		for (const w of [...works, ...archive]) byId.set(w.id, w);
		return [...byId.values()];
	}, [works, archive]);

	const tasksByParentId = useMemo(() => {
		const map = new Map<string, WorkListItem[]>();
		for (const w of known) {
			if (w.type === "task" && w.parent_id) {
				const list = map.get(w.parent_id);
				if (list) {
					list.push(w);
				} else {
					map.set(w.parent_id, [w]);
				}
			}
		}
		return map;
	}, [known]);

	const titleById = useMemo(
		() => new Map(known.map((w) => [w.id, w.title])),
		[known],
	);

	const groups = useMemo(() => {
		const byGroup = new Map<WorkGroup, WorkListItem[]>();
		for (const w of works) {
			const group = rowGroup(w);
			if (!group) continue;
			const list = byGroup.get(group);
			if (list) {
				list.push(w);
			} else {
				byGroup.set(group, [w]);
			}
		}
		// A group with no rows is not rendered, header and all; the rows inside
		// keep the order the list arrived in, so a work that starts or blocks
		// while the list is being read only moves if it changed group.
		return GROUP_ORDER.flatMap((group) => {
			const rows = byGroup.get(group);
			return rows ? [{ group, rows }] : [];
		});
	}, [works]);

	// The order is the server's, not re-derived here: the page was cut along a
	// cursor into that order, and a client sorting it again would answer ties
	// differently from the cut it is showing.
	const closedStories = useMemo(
		() => archive.filter((w) => w.type === "story" && w.status === "closed"),
		[archive],
	);

	const renderRow = (work: WorkListItem) => (
		<WorkRow
			key={work.id}
			work={work}
			tasks={work.type === "story" ? tasksByParentId.get(work.id) : undefined}
			// Slot 2 is the list's, not the row's: a task is here because it left
			// its story, and without the story's name it is a title with no
			// context (docs/project-ui.md §3.1).
			parentTitle={
				work.type === "task" && work.parent_id
					? titleById.get(work.parent_id)
					: undefined
			}
			roleName={
				work.agent_role_id ? roleNameMap.get(work.agent_role_id) : undefined
			}
			showUpdatedAt={segment === "closed"}
			onOpen={onOpenWorkDetail}
			onOpenChat={onNavigateToSession}
		/>
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
					Project
				</h1>
			</header>

			{/* Outside the scroll area on purpose: the archive is one tap away from
			    wherever the list has been scrolled to. */}
			<SegmentedControl segment={segment} />

			<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-2">
				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="size-5 animate-spin text-th-text-muted" />
					</div>
				) : error ? (
					<div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-th-error">
						<AlertCircle className="size-5" />
						<p>{error}</p>
					</div>
				) : segment === "closed" ? (
					<>
						{/* Above the rows rather than instead of them: a page that did
						    not arrive is no reason to take away the one the user was
						    reading, and Retry asks for the page that failed, which is
						    not always the page on screen. */}
						{archiveError && (
							<div className="flex flex-col items-center gap-2 py-4 text-center text-sm text-th-error">
								<AlertCircle className="size-5" />
								<p role="alert">{archiveError}</p>
								<button
									type="button"
									onClick={() =>
										workPagingActions.loadArchivePage(
											archiveAttempt.page,
											archiveAttempt.cursor,
										)
									}
									className="min-h-[44px] rounded-lg px-4 text-sm text-th-text-primary hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
								>
									Retry
								</button>
							</div>
						)}
						{!archiveLoaded ? (
							!archiveError && (
								<div className="flex items-center justify-center py-8">
									<Loader2 className="size-5 animate-spin text-th-text-muted" />
								</div>
							)
						) : closedStories.length === 0 ? (
							// No action to offer here, so none is written.
							<p className="py-8 text-center text-sm text-th-text-muted">
								Nothing finished yet.
							</p>
						) : (
							<div className="space-y-0.5">{closedStories.map(renderRow)}</div>
						)}
					</>
				) : groups.length === 0 ? (
					<div className="py-8 text-center text-sm text-th-text-muted">
						<p>Nothing on the go.</p>
						<p>Start with a story — the button below.</p>
					</div>
				) : (
					<div className="space-y-2">
						{groups.map(({ group, rows }) => (
							<section key={group}>
								<GroupHeading
									group={group}
									// The whole group's, not the number of rows fetched: a
									// heading reading `Not running 50` over a group of 120 is
									// not a smaller number, it is a wrong one
									// (docs/list-paging-ui.md §4.1).
									count={
										group === "not_running"
											? rows.length + notRunningHidden
											: rows.length
									}
								/>
								{group === "not_running" && notRunningHidden > 0 && (
									// Above the rows, because it is the only control on this
									// screen that leads backwards and it points the way it
									// leads: the rows it fetches are the oldest, taken off the
									// front of a group that is in creation order.
									<ShowEarlierWork
										count={notRunningHidden}
										isLoading={isEarlierLoading}
										error={earlierError}
									/>
								)}
								<div className="space-y-0.5">{rows.map(renderRow)}</div>
							</section>
						))}
					</div>
				)}
			</div>

			{/* Fixed above the bottom bar rather than at the end of the list, and
			    absent entirely while there is only one page (docs/list-paging-ui.md
			    §4.2, sidebar-ui.md principle 1). */}
			{segment === "closed" &&
				archiveLoaded &&
				(archivePage > 0 || archiveNextCursor !== null) && (
					<ArchivePager
						page={archivePage}
						hasNewer={archivePage > 0}
						hasOlder={archiveNextCursor !== null}
						onNewer={goNewer}
						onOlder={goOlder}
					/>
				)}

			{/* Fixed, and in both segments: creating is the most frequent action on
			    this screen, it does not depend on the list having loaded, and the
			    top-of-list form it replaces scrolled away exactly when a long list
			    made it most useful (docs/project-ui.md §4). */}
			<BottomActionBar>
				<button
					type="button"
					onClick={() => setCreating(true)}
					className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-th-accent text-sm font-medium text-th-accent-text"
				>
					<Plus className="size-4" />
					New Story
				</button>
			</BottomActionBar>

			{creating && (
				<CreateWorkSheet
					type="story"
					onClose={() => setCreating(false)}
					onCreated={handleCreated}
				/>
			)}
		</div>
	);
}

const SEGMENT_LABEL: Record<WorkSegment, string> = {
	current: "Current",
	closed: "Closed",
};

/**
 * Two segments, and the words are chosen against the state vocabulary rather
 * than for brevity: "Closed" is exactly the status of what is in it, while
 * "Current" names nothing in the vocabulary on purpose — "Open" and "Active"
 * are both status values, and a segment wearing either would claim a
 * membership it does not have (docs/project-ui.md §2.1).
 *
 * Neither segment carries a count: a count is a signal to act, the group
 * headings inside `Current` already carry the ones that are, and a running
 * total of finished work is a number nobody acts on.
 */
function SegmentedControl({ segment }: { segment: WorkSegment }) {
	return (
		// A group and not a tablist: the tab pattern promises a panel per tab and
		// an arrow-key walk between them, and this is one list under a filter.
		<fieldset
			aria-label="Which work to list"
			// `min-w-0` against the one thing a fieldset does that a div does not:
			// its `min-inline-size: min-content` would stop the two segments
			// sharing the width of a narrow phone.
			className="flex min-w-0 gap-1 border-b border-th-border bg-th-bg-secondary p-1"
		>
			{(["current", "closed"] as const).map((value) => (
				<button
					key={value}
					type="button"
					aria-pressed={segment === value}
					onClick={() => projectPanelActions.setSegment(value)}
					className={`min-h-[44px] flex-1 rounded-md px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
						segment === value
							? "bg-th-bg-tertiary font-medium text-th-text-primary"
							: "text-th-text-muted hover:text-th-text-primary"
					}`}
				>
					{SEGMENT_LABEL[value]}
				</button>
			))}
		</fieldset>
	);
}

/**
 * The three groups of the `Current` segment (docs/project-ui.md §2.3).
 *
 * Two questions decide the group, asked in this order: is an engine driving
 * this work, and if it is, is it blocked on the user? Membership never reads
 * the full activity beyond that one predicate — a list that regrouped on every
 * phase change would reorder itself while being read.
 */
type WorkGroup = "needs_you" | "in_progress" | "not_running";

/** The things to do come before the things running by themselves. */
const GROUP_ORDER: WorkGroup[] = ["needs_you", "in_progress", "not_running"];

const GROUP_LABEL: Record<WorkGroup, string> = {
	needs_you: "Needs you",
	in_progress: "In progress",
	not_running: "Not running",
};

/**
 * The leaf each heading borrows its glyph and tone from.
 *
 * Fixed per group and never taken from the rows inside it: *Needs you* holds
 * three different leaves, and a heading wearing one of them would mislabel the
 * other two. The rows keep their own precise leaf, which is where the
 * distinction belongs — so these are drawn `decorative`, with the written label
 * as the only thing announced.
 */
const GROUP_GLYPH: Record<WorkGroup, Activity> = {
	needs_you: "needs_message",
	in_progress: "running",
	not_running: "open",
};

/**
 * Which group a work is a row in, or `null` when it gets no row of its own.
 *
 * A row exists for every story, and for every task that needs a person —
 * `needsUser` or `stopped`, the two ways a task can be stuck with nobody coming
 * for it. Everything else about a task is rolled up into its story's row
 * (docs/project-ui.md §2.2). `stopped` stays out of *Needs you* deliberately:
 * it needs a human whenever the human gets to it, and a stale stopped work at
 * the top of that group would teach the user its count is not a number of
 * things to do.
 */
function rowGroup(work: WorkListItem): WorkGroup | null {
	if (work.status === "closed") return null;
	if (work.status === "active") {
		if (needsUser(work.activity)) return "needs_you";
		return work.type === "story" ? "in_progress" : null;
	}
	// `open` and `stopped` differ in how they got there, not in what the user
	// does about them: the row's own control is Start or Restart, one control
	// under two labels, and the row's glyph already tells them apart.
	if (work.status === "stopped") return "not_running";
	return work.type === "story" ? "not_running" : null;
}

/**
 * The one control that leads backwards: it fetches the oldest rows of *Not
 * running*, which the server held back above a generous number
 * (docs/list-paging-ui.md §4.1).
 *
 * It is a cap being lifted, not a page being turned — one press loads all of
 * them, and the control is gone afterwards, so there is no second press and
 * nothing that says how far back it goes.
 */
function ShowEarlierWork({
	count,
	isLoading,
	error,
}: {
	count: number;
	isLoading: boolean;
	error: string | null;
}) {
	return (
		<div className="flex flex-col">
			{error && (
				<p role="alert" className="px-3 py-1 text-xs text-th-error">
					{error}
				</p>
			)}
			<button
				type="button"
				onClick={() => workPagingActions.loadEarlier()}
				className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg text-sm text-th-text-muted transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			>
				{isLoading ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<ChevronUp className="size-4" />
				)}
				{error ? "Retry" : `Show earlier work (${count})`}
			</button>
		</div>
	);
}

/**
 * Inert: a glyph, a label, a count, and no toggle. Collapsing was for getting
 * the archive out of the way, and the archive is a segment now; a heading is
 * also what lets a screen reader jump between groups, which the buttons never
 * offered.
 */
function GroupHeading({ group, count }: { group: WorkGroup; count: number }) {
	return (
		// Above the rows rather than level with them: a row lifts its own
		// controls to `z-10`, and a Stop button sliding over the heading it is
		// scrolling under would be drawn on top of it at the same level.
		<h2 className="sticky top-0 z-20 flex min-h-[32px] items-center gap-2 bg-th-bg-primary px-3 text-xs font-medium text-th-text-muted">
			<ActivityIcon activity={GROUP_GLYPH[group]} decorative />
			<span className="flex-1">{GROUP_LABEL[group]}</span>
			{/* Rows in the group, not work items in a tree: the tasks folded into a
			    story row are counted in that row's own meta line. */}
			<span className="rounded-full bg-th-bg-tertiary px-1.5 py-0.5 tabular-nums">
				{count}
			</span>
		</h2>
	);
}
