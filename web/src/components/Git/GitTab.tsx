import { useQueryClient } from "@tanstack/react-query";
import {
	FileDiff,
	GitBranch,
	History,
	type LucideIcon,
	TriangleAlert,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { invalidateGitQueries } from "../../hooks/gitQueries";
import { useSharedMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { useGitBranches } from "../../hooks/useGitBranches";
import {
	describeChangeCount,
	describeChangeLines,
	useGitChangeCount,
	useGitChangeLines,
} from "../../hooks/useGitChangeCount";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useAutoFetch } from "../../hooks/useGitSync";
import type { BranchRow } from "../../lib/gitBranches";
import {
	describeOperation,
	headBranchOf,
	rebasingBranch,
} from "../../lib/gitOperation";
import { useSyncRun } from "../../lib/gitSyncStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import {
	type BranchRef,
	branchRowKey,
	type CommitOrigin,
	commitOriginOf,
	DEFAULT_HISTORY_QUERY,
	type GitLayer,
	type GitSegment,
	gitSegmentOf,
	type HistoryQuery,
	historyQueryOf,
} from "../../types/overlay";
import {
	describeSyncStatus,
	describeSyncStep,
	hasSyncStatus,
	RUNNING_DESCRIPTION,
} from "../../utils/gitSyncStatus";
import { useSidebarRefresh } from "../Layout";
import { formatBadgeCount, Spinner } from "../ui";
import BranchBar, { HeadName } from "./BranchBar";
import GitSegmentList, { activeRowsOf } from "./GitSegmentList";
import HeadPlaceholder from "./HeadPlaceholder";
import LineCounts, { formatLineCounts } from "./LineCounts";
import OperationBanner from "./OperationBanner";

/** The Git routes' navigations, as the app shell makes them. */
export interface GitNavigation {
	/** Opens a segment's list. */
	onSelectSegment: (segment: GitSegment) => void;
	onSelectFile: (path: string, staged: boolean) => void;
	/** Moves the review off a file just discarded from the list. */
	onCloseFile: (
		path: string,
		worktree: string,
		next: { path: string; staged: boolean } | null,
	) => void;
	/**
	 * Opens a commit carrying `origin`, the list it was picked from; the open
	 * layer's when left out.
	 */
	onSelectCommit: (hash: string, origin?: CommitOrigin) => void;
	onSelectBranch: (branch: BranchRef) => void;
	/**
	 * Replaces the detail of `from` with `to`'s, or with the Branches list —
	 * only while that detail is still the one open in `worktree`.
	 */
	onRepointBranch: (
		from: BranchRef,
		to: BranchRef | null,
		worktree: string,
	) => void;
}

interface Props {
	isExpanded: boolean;
	/** The sidebar is on screen: the drawer open, or the column not collapsed. */
	isOpen: boolean;
	/** The Git layer the route names, and null when it names none. */
	layer: GitLayer | null;
	navigation: GitNavigation;
	/**
	 * Told whether the list is on screen — `expanded`, this tab selected, the
	 * column not collapsed — for the detail beside it, which shows its own
	 * failures while it is not. Must be stable.
	 */
	onListShownChange?: (shown: boolean) => void;
}

/**
 * The sidebar's Git tab, in one of two shapes (docs/sidebar-ui.md).
 *
 * At `expanded` it is the Git workspace's list — the branch bar, the segments
 * and the list under them — and the main area beside it shows what a row
 * opens, or the chat. Below `expanded` the drawer is too short for a list and
 * the workspace is a page of its own, so the tab is where the worktree stands
 * and the doors into that page — the same shape as the Project tab. Either
 * way each write is in one place: the sidebar's at `expanded`, the page's
 * below it.
 */
function GitTab({
	isExpanded,
	isOpen,
	layer,
	navigation,
	onListShownChange,
}: Props) {
	const queryClient = useQueryClient();
	const refreshAll = useCallback(
		() => invalidateGitQueries(queryClient),
		[queryClient],
	);
	const { isActive } = useSidebarRefresh("git", refreshAll);
	const listShown = isExpanded && isActive && isOpen;
	useEffect(() => {
		onListShownChange?.(listShown);
		return () => onListShownChange?.(false);
	}, [listShown, onListShownChange]);

	if (isExpanded) {
		return (
			<div className={isActive ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
				{listShown && <AutoFetch />}
				<GitTabLists
					layer={layer}
					navigation={navigation}
					listShown={listShown}
				/>
			</div>
		);
	}
	return (
		<div className={isActive ? "flex flex-col" : "hidden"}>
			<Overview />
			<Doors
				activeSegment={layer && gitSegmentOf(layer)}
				onOpenSegment={navigation.onSelectSegment}
			/>
		</div>
	);
}

/**
 * Arriving at the list is arriving in the workspace, as the page below
 * `expanded` is (`GitWorkspace`): the tab coming on screen decides once
 * whether to fetch.
 */
function AutoFetch() {
	useAutoFetch();
	return null;
}

/** What the list stood at when the route last named a Git layer. */
interface ListPlace {
	worktree: string;
	segment: GitSegment;
	history: HistoryQuery;
}

function GitTabLists({
	layer,
	navigation,
	listShown,
}: {
	layer: GitLayer | null;
	navigation: GitNavigation;
	listShown: boolean;
}) {
	const worktree = useWorktreeStore((s) => s.current);
	const mergeHandoff = useSharedMergeHandoff();

	// The route says which list while it names a Git layer. Once it names
	// something else — a session, a file — the tab stays at the list it was
	// left at rather than jumping back to Changes; in another worktree, without
	// the search and file filter, which may name nothing there (as a worktree
	// switch from the workspace does, `useWorktree`).
	const [last, setLast] = useState<ListPlace>({
		worktree,
		segment: "changes",
		history: DEFAULT_HISTORY_QUERY,
	});
	const routed: ListPlace | null = layer && {
		worktree,
		segment: gitSegmentOf(layer) ?? "changes",
		history: historyQueryOf(layer),
	};
	if (routed && !samePlace(routed, last)) setLast(routed);
	const place: ListPlace = routed ?? {
		worktree,
		segment: last.segment,
		history:
			last.worktree === worktree ? last.history : { scope: last.history.scope },
	};
	const { activeFile, activeHash, activeBranchKey } = activeRowsOf(layer);
	const litId =
		place.segment === "changes"
			? activeFile?.path
			: place.segment === "history"
				? activeHash
				: activeBranchKey;
	const lit = litId ? litRowKey(place.segment, litId) : null;
	const { reveal, onPress, listRef } = useLitRowReveal(lit, listShown);

	// A commit carries the list it was picked from, which is the one the tab
	// shows even when the route no longer names it.
	const listLayer: GitLayer = layer ?? {
		type: "git",
		segment: place.segment,
		history: place.history,
	};
	const onSelectFile = (path: string, staged: boolean) => {
		onPress(litRowKey("changes", path));
		navigation.onSelectFile(path, staged);
	};
	const onSelectCommit = (hash: string) => {
		onPress(litRowKey("history", hash));
		navigation.onSelectCommit(hash, commitOriginOf(listLayer));
	};
	const onSelectBranch = (branch: BranchRef) => {
		onPress(litRowKey("branches", branchRowKey(branch)));
		navigation.onSelectBranch(branch);
	};
	const onBranchDeleted = (row: BranchRow) =>
		navigation.onRepointBranch(
			{ ref: row.label, remote: row.remote },
			null,
			worktree,
		);

	return (
		<div ref={listRef} className="flex min-h-0 flex-1 flex-col">
			<BranchBar
				onOpenBranches={() => navigation.onSelectSegment("branches")}
				branchFailureSurface={place.segment === "branches"}
				mergeHandoff={mergeHandoff}
			/>
			<OperationBanner
				compact={false}
				onSelectFile={(path) => navigation.onSelectFile(path, false)}
			/>
			<GitSegmentList
				segment={place.segment}
				history={place.history}
				activeFile={activeFile}
				activeHash={activeHash}
				activeBranchKey={activeBranchKey}
				reveal={reveal}
				mergeHandoff={mergeHandoff}
				onSelectSegment={navigation.onSelectSegment}
				onSelectFile={onSelectFile}
				onCloseFile={navigation.onCloseFile}
				onSelectCommit={onSelectCommit}
				onSelectBranch={onSelectBranch}
				onBranchDeleted={onBranchDeleted}
			/>
		</div>
	);
}

function litRowKey(segment: GitSegment, id: string): string {
	return `${segment}\0${id}`;
}

/**
 * When the list scrolls its lit row (`lit`, null for none) into view: when
 * the row lit changes for a reason other than the user pressing it here — a
 * detail opened from the chat, a link, the detail stepping to the next file —
 * and when the list comes back on screen, having lost its scroll position
 * while hidden. A request waits for the list to be shown and for the row to
 * be listed, and is dropped once the user reaches for the list, so they are
 * never pulled back to it.
 */
function useLitRowReveal(lit: string | null, shown: boolean) {
	const [pending, setPending] = useState(false);
	// The row the user just pressed here, which is on screen already.
	const [pressed, setPressed] = useState<string | null>(null);
	const [seen, setSeen] = useState<{ lit: string | null; shown: boolean }>({
		lit: null,
		shown: false,
	});
	if (lit !== seen.lit || shown !== seen.shown) {
		setSeen({ lit, shown });
		const moved = lit !== seen.lit;
		if (moved) setPressed(null);
		if (lit === null) setPending(false);
		else if ((moved && lit !== pressed) || (shown && !seen.shown)) {
			setPending(true);
		}
	}
	const revealed = useCallback(() => setPending(false), []);

	// The user reaching for the list — a wheel, a finger, the scrollbar, a
	// key — takes over from a reveal still waiting for its row. Not `scroll`:
	// the reveal's own scrolling, and the list keeping its top row, fire it too.
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = listRef.current;
		if (!el || !pending) return;
		const events = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
		for (const type of events) {
			el.addEventListener(type, revealed, { capture: true, passive: true });
		}
		return () => {
			for (const type of events) {
				el.removeEventListener(type, revealed, { capture: true });
			}
		};
	}, [pending, revealed]);

	return {
		reveal: pending && shown ? revealed : undefined,
		onPress: setPressed,
		listRef,
	};
}

function samePlace(a: ListPlace, b: ListPlace): boolean {
	return (
		a.worktree === b.worktree &&
		a.segment === b.segment &&
		a.history.scope === b.history.scope &&
		a.history.q === b.history.q &&
		a.history.file === b.history.file
	);
}

/**
 * The doors into the workspace's segments. Nothing here writes: below
 * `expanded` every write lives once, in the workspace.
 */
function Doors({
	activeSegment,
	onOpenSegment,
}: {
	/** The segment the workspace is standing in, and null when it is not on screen. */
	activeSegment: GitSegment | null;
	onOpenSegment: (segment: GitSegment) => void;
}) {
	const changeCount = useGitChangeCount();
	const changeLines = useGitChangeLines();
	const hasLines = changeLines !== null && formatLineCounts(changeLines) !== "";

	return (
		<div className="space-y-1 p-2">
			<Entry
				icon={FileDiff}
				label="Changes"
				isActive={activeSegment === "changes"}
				onClick={() => onOpenSegment("changes")}
				ariaLabel={
					changeCount
						? [
								"Changes",
								describeChangeCount(changeCount),
								hasLines && describeChangeLines(changeLines),
							]
								.filter(Boolean)
								.join(", ")
						: undefined
				}
			>
				{/* Nothing while the status has no answer: like the tab's badge,
				    this is not where a failed read is reported — the workspace
				    says it. */}
				{changeCount === 0 ? (
					<span className="ml-auto text-xs text-th-text-muted">No changes</span>
				) : changeCount !== undefined ? (
					<span className="ml-auto flex min-w-0 items-baseline gap-2">
						<span className="text-xs tabular-nums text-th-text-secondary">
							{formatBadgeCount(changeCount)}
						</span>
						{hasLines && <LineCounts lines={changeLines} />}
					</span>
				) : null}
			</Entry>
			<Entry
				icon={History}
				label="History"
				isActive={activeSegment === "history"}
				onClick={() => onOpenSegment("history")}
			/>
			<Entry
				icon={GitBranch}
				label="Branches"
				isActive={activeSegment === "branches"}
				onClick={() => onOpenSegment("branches")}
			/>
		</div>
	);
}

/**
 * Read-only on purpose: something drawn like the chip that does nothing when
 * pressed is worse than no chip, and the entries below already go everywhere
 * it could.
 */
function Overview() {
	const { data: branches, isLoading, error } = useGitBranches();
	const worktree = useWorktreeStore((s) => s.current);
	const run = useSyncRun(worktree);
	const { data: gitStatus } = useGitStatus();
	const operation = gitStatus?.operation;

	const head = branches?.head;
	const sync = branches?.sync;

	// Data first, as in the workspace's top bar: a failed refetch keeps the
	// branch already known.
	if (!head) {
		return (
			<div className="flex min-h-[44px] items-center border-b border-th-border px-2">
				<HeadPlaceholder isLoading={isLoading} error={error} />
			</div>
		);
	}

	// The same description the workspace's sync chip is drawn from, so the two
	// cannot disagree about what the branch needs.
	const status = hasSyncStatus(head, sync)
		? describeSyncStatus(sync, run)
		: null;
	// A repository stuck mid-operation is what the doorplate has to say, in
	// place of the sync line (docs/git-conflict-ui.md).
	const operationTitle = operation
		? describeOperation(
				operation,
				gitStatus?.conflicted?.length ?? 0,
				headBranchOf(head),
			).title
		: null;

	return (
		<div className="space-y-1 border-b border-th-border px-4 py-2.5">
			<div className="flex min-w-0 items-center gap-2 text-th-text-primary">
				<GitBranch
					className="h-4 w-4 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<HeadName head={head} rebasing={rebasingBranch(operation)} />
			</div>
			{operationTitle ? (
				<div className="flex items-center gap-1.5 pl-6 text-xs text-th-text-secondary">
					<TriangleAlert
						className="h-3 w-3 shrink-0 text-th-warning"
						aria-hidden="true"
					/>
					<span className="min-w-0 truncate">{operationTitle}</span>
				</div>
			) : (
				status && (
					<div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-6 text-xs text-th-text-secondary">
						<span>{sentence(describeSyncStep(status.step))}</span>
						{status.running && (
							<span className="flex items-center gap-1">
								<span aria-hidden="true">·</span>
								<Spinner variant="current" size="h-3 w-3" srText={null} />
								{sentence(RUNNING_DESCRIPTION[status.running])}
							</span>
						)}
						{status.autoFetchFailed && (
							<span className="flex items-center gap-1 text-th-warning">
								<span aria-hidden="true">·</span>
								<TriangleAlert className="h-3 w-3" aria-hidden="true" />
								Automatic fetch failed
							</span>
						)}
					</div>
				)
			)}
		</div>
	);
}

function sentence(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

interface EntryProps {
	icon: LucideIcon;
	label: string;
	isActive: boolean;
	onClick: () => void;
	ariaLabel?: string;
	children?: ReactNode;
}

function Entry({
	icon: Icon,
	label,
	isActive,
	onClick,
	ariaLabel,
	children,
}: EntryProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={ariaLabel}
			// Still pressable while lit: it is the way back to that segment's list.
			aria-current={isActive ? "page" : undefined}
			className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-[0.98] ${
				isActive ? "bg-th-bg-tertiary" : ""
			}`}
		>
			<Icon className="size-4 text-th-text-muted" aria-hidden="true" />
			{label}
			{children}
		</button>
	);
}

export default GitTab;
