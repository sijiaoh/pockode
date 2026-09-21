import { AlertCircle, ChevronUp, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoleNameMap } from "../../hooks/useRoleNameMap";
import { type Activity, needsAttention } from "../../lib/activity";
import { byUpdatedDesc } from "../../lib/workOrder";
import {
	useWorkStore,
	type WorkListHidden,
	workPagingActions,
} from "../../lib/workStore";
import type { WorkSegment } from "../../types/overlay";
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
	segment: WorkSegment;
	onSelectSegment: (segment: WorkSegment) => void;
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
	segment,
	onSelectSegment,
	onBack,
	onOpenWorkDetail,
	onNavigateToSession,
}: Props) {
	const works = useWorkStore((s) => s.works);
	const isLoading = useWorkStore((s) => s.isLoading);
	const error = useWorkStore((s) => s.error);
	const hidden = useWorkStore((s) => s.hidden);
	const isEarlierLoading = useWorkStore((s) => s.isEarlierLoading);
	const earlierError = useWorkStore((s) => s.earlierError);
	const archive = useWorkStore((s) => s.archive);
	const archivePage = useWorkStore((s) => s.archivePage);
	const archiveCursors = useWorkStore((s) => s.archiveCursors);
	const archiveNextCursor = useWorkStore((s) => s.archiveNextCursor);
	const archiveLoaded = useWorkStore((s) => s.archiveLoaded);
	const archiveAttempt = useWorkStore((s) => s.archiveAttempt);
	const archiveError = useWorkStore((s) => s.archiveError);
	const archiveStale = useWorkStore((s) => s.archiveStale);
	const isArchiveLoading = useWorkStore((s) => s.isArchiveLoading);
	const pagingGeneration = useWorkStore((s) => s.pagingGeneration);
	const roleNameMap = useRoleNameMap();
	const [creating, setCreating] = useState(false);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	// The archive is fetched, never pushed, so the first page is asked for the
	// first time the segment is looked at — and not before: a user who never
	// opens it never pays for it.
	//
	// And asked for again once a work has closed behind it: a page cut before
	// that no longer says what the server would, and it is this segment being on
	// screen that makes "the next time the page is loaded" (§4.3) happen at all.
	// The page re-asked for is the one the reader is on, not the first — a close
	// belongs at the top of page 1 and cannot move a window further down, so
	// somebody reading page 3 keeps it.
	//
	// `pagingGeneration` is in the dependencies because a resubscribe leaves the
	// archive unloaded on purpose, and it is what says the absence belongs to a
	// subscription that can actually answer. `isArchiveLoading` is there because
	// a fetch already in flight declines this one, and nothing else would come
	// back for it once that fetch lands.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pagingGeneration and isArchiveLoading are intentional triggers — a fresh subscription is what makes the missing page fetchable again, and a landing fetch is what frees a refresh it turned away
	useEffect(() => {
		if (segment !== "closed") return;
		if (!archiveLoaded) {
			workPagingActions.loadArchivePage(0, "");
			return;
		}
		// Never over a failed page. The reader has an error and a Retry in front of
		// them, and both are cleared by any fetch starting — so a work closing
		// somewhere else would silently withdraw the one control that answers the
		// failure they are looking at, and re-point it at a different page.
		if (archiveStale && !archiveError) {
			workPagingActions.loadArchivePage(
				archivePage,
				archiveCursors[archivePage] ?? "",
			);
		}
	}, [
		segment,
		archiveLoaded,
		archiveStale,
		archiveError,
		archivePage,
		archiveCursors,
		isArchiveLoading,
		pagingGeneration,
	]);

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
		// A group with no rows is not rendered, header and all — which is the
		// whole of the empty state for *Stopped*: a project with nothing stopped
		// has no heading and no gap where one would be, and the list opens on
		// *Needs you* exactly as it did before.
		return GROUP_ORDER.flatMap((group) => {
			const rows = byGroup.get(group);
			if (!rows) return [];
			const key = HIDDEN_KEY[group];
			// Sorted in place: these arrays were just built here, and nothing else
			// holds them.
			rows.sort(byUpdatedDesc);
			return [{ group, rows, hidden: key ? hidden[key] : 0 }];
		});
	}, [works, hidden]);

	// One failure, one message. `loadEarlier` is a single action over the whole
	// segment, so when both capped groups offer the control, the error and the
	// Retry it turns into belong to the first of them. Two copies would announce
	// the same failure twice and leave two buttons reading `Retry` with nothing
	// to tell them apart; the second group keeps saying what it does, and
	// pressing it asks for exactly the same thing.
	const earlierErrorGroup = groups.find((g) => g.hidden > 0)?.group;

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
			// Slot 1 is the list's, not the row's: a task is here because it left
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
			// In both segments: `Current` is sorted by it now, and a sort key the
			// user cannot see is not an order they can read
			// (docs/project-ui.md §3).
			showUpdatedAt
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
			<SegmentedControl segment={segment} onSelect={onSelectSegment} />

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
							<div className="space-y-2">{closedStories.map(renderRow)}</div>
						)}
					</>
				) : groups.length === 0 ? (
					<div className="py-8 text-center text-sm text-th-text-muted">
						<p>Nothing on the go.</p>
						<p>Start with a story — the button below.</p>
					</div>
				) : (
					<div className="space-y-4">
						{groups.map(({ group, rows, hidden: groupHidden }) => (
							<section key={group}>
								<GroupHeading
									group={group}
									// The whole group's, not the number of rows fetched: a
									// heading reading `Not running 50` over a group of 120 is
									// not a smaller number, it is a wrong one
									// (docs/list-paging-ui.md §4.1).
									count={rows.length + groupHidden}
								/>
								{groupHidden > 0 && (
									// Above the rows, because it leads backwards and points
									// the way it leads: the rows it fetches are the least
									// recently updated, off the bottom of a group listed
									// newest first.
									//
									// Both capped groups can offer one at the same time, and
									// pressing either lifts both caps: it is a lid coming off
									// the segment, not a page being turned
									// (docs/list-paging-ui.md §4.1).
									<ShowEarlierWork
										count={groupHidden}
										isLoading={isEarlierLoading}
										error={group === earlierErrorGroup ? earlierError : null}
									/>
								)}
								<div className="space-y-2">{rows.map(renderRow)}</div>
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
function SegmentedControl({
	segment,
	onSelect,
}: {
	segment: WorkSegment;
	onSelect: (segment: WorkSegment) => void;
}) {
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
					onClick={() => onSelect(value)}
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
 * The four groups of the `Current` segment (docs/project-ui.md §2.3).
 *
 * The status is asked first, then the activity: a work that was handed back to
 * a person is in *Stopped* whatever else is true of it, and only what is still
 * being driven is sorted by whether it is blocked on the user. Membership never
 * reads the full activity beyond that one predicate — a list that regrouped on
 * every phase change would reorder itself while being read.
 */
type WorkGroup = "stopped" | "needs_you" | "in_progress" | "not_running";

/**
 * The things that cannot move by themselves come first, then the things that
 * can.
 *
 * *Stopped* leads because it is the only group where nothing at all happens
 * until a person acts: *Needs you* at least has an agent alive and waiting, and
 * it resumes the moment it is answered. The first two entries are swappable —
 * an agent idling costs real time too — and the case for swapping them is a
 * *Stopped* group that sits at five or more rows for days, which would push
 * *Needs you* off the first screen. Nothing else reads this order, so that is a
 * one-line change.
 */
const GROUP_ORDER: WorkGroup[] = [
	"stopped",
	"needs_you",
	"in_progress",
	"not_running",
];

/**
 * Group names come from the status vocabulary, the way the `Closed` segment's
 * does: *Stopped* is the status of every row in it and the word already printed
 * on each of those rows, so the heading names them rather than paraphrasing
 * them ("Needs restart" would be a fourth phrasing of one state).
 */
const GROUP_LABEL: Record<WorkGroup, string> = {
	stopped: "Stopped",
	needs_you: "Needs you",
	in_progress: "In progress",
	not_running: "Not running",
};

/**
 * Which of the server's two hidden counts a group's heading adds to its rows.
 *
 * Absent for the two groups that are never capped — a heading with no entry
 * here shows the rows it has and offers no control, which is the same thing as
 * "this group arrived whole" and always will.
 */
const HIDDEN_KEY: Partial<Record<WorkGroup, keyof WorkListHidden>> = {
	stopped: "stopped",
	not_running: "open",
};

/**
 * The leaf each heading borrows its glyph and tone from.
 *
 * Fixed per group and never taken from the rows inside it: *Needs you* holds
 * rows waiting on a permission decision and rows with questions outstanding, and
 * the second of those is not an activity at all — a heading wearing either row's
 * glyph would mislabel the rest. The rows keep their own precise leaf, which is
 * where the distinction belongs, so these are drawn `decorative` with the
 * written label as the only thing announced.
 */
const GROUP_GLYPH: Record<WorkGroup, Activity> = {
	// The one group whose heading glyph is necessarily every row's as well,
	// since the leaf *is* the membership rule. Still fixed here rather than read
	// off a row: the rule is the rule.
	stopped: "stopped",
	needs_you: "needs_permission",
	in_progress: "running",
	not_running: "open",
};

/**
 * Which group a work is a row in, or `null` when it gets no row of its own.
 *
 * A row exists for every story, and for every task that needs a person —
 * `needsAttention` or `stopped`, the two ways a task can be stuck with nobody
 * coming for it. Everything else about a task is rolled up into its story's row
 * (docs/project-ui.md §2.2). Which items get rows is untouched by the split of
 * *Stopped* out of *Not running*: the same rows exist, in different groups.
 *
 * `stopped` still stays out of *Needs you* deliberately: that group's count is
 * "an agent is waiting on me right now", and a work stopped three days ago
 * would teach the user it is not. It gets its own group and its own count
 * instead — `open` is "nobody has started this", `stopped` is "something that
 * was started broke off", and one number over both is neither a backlog nor a
 * list of debts.
 */
function rowGroup(work: WorkListItem): WorkGroup | null {
	if (work.status === "closed") return null;
	// Before the activity is looked at: a stopped work has no agent, so whatever
	// its last activity was says nothing about what happens next.
	if (work.status === "stopped") return "stopped";
	if (work.status === "active") {
		if (needsAttention(work.activity, work.unanswered_questions))
			return "needs_you";
		return work.type === "story" ? "in_progress" : null;
	}
	return work.type === "story" ? "not_running" : null;
}

/**
 * The one control that leads backwards: it fetches the least recently updated
 * rows of a capped group, which the server held back above a generous number
 * (docs/list-paging-ui.md §4.1).
 *
 * It is a cap being lifted, not a page being turned — one press loads all of
 * them, in *both* capped groups, and every copy of the control is gone
 * afterwards. So there is no second press and nothing that says how far back it
 * goes.
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
		// `mb-2` for the same reason the rows are `space-y-2`: this button is a
		// 44px hit area and so is the whole of the row under it, and neighbouring
		// targets owe each other 8px on a coarse pointer
		// (docs/responsive-ui.md#hit-areas-and-spacing).
		<div className="mb-2 flex flex-col">
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
