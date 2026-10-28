import {
	ConfirmDialog,
	useIsPageCovered,
	useOutsideClick,
} from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
	ALargeSmall,
	ChevronLeft,
	ChevronRight,
	Columns2,
	Loader2,
	Sparkles,
	WrapText,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { operationPromptAtPress } from "../../hooks/gitQueries";
import { useGitDiffWatch } from "../../hooks/useGitDiffWatch";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitWriteRunner } from "../../hooks/useGitWrites";
import { useLeaveReview } from "../../hooks/useLeaveReview";
import { usePrefillComposer } from "../../hooks/usePrefillComposer";
import { useRouteState } from "../../hooks/useRouteState";
import { type DiffHunk, parseHunks } from "../../lib/diffHunks";
import {
	applyPress,
	buildDiffRows,
	capitalize,
	describeRange,
	hunkLineRange,
	type LinePress,
	type LineRange,
	rangeSignature,
	relocateRange,
	resolveRange,
	rowKey,
	selectionCopyText,
	selectionPrefillText,
} from "../../lib/diffRows";
import {
	useDiffSettings,
	useGitDiffSplit,
	useGitDiffWrap,
} from "../../lib/diffSettingsStore";
import {
	adjacentChange,
	type ChangedFile,
	changeKindOf,
	collectChanges,
	orderChanges,
	reviewSideOf,
	stagesOnlyWhole,
	unstagePaths,
} from "../../lib/gitChanges";
import { useGitChangesViewStore } from "../../lib/gitChangesViewStore";
import {
	gitWriteActions,
	isPathWriting,
	WorktreeChangedError,
} from "../../lib/gitWriteStore";
import { overlayToNavigation } from "../../lib/navigation";
import { useWorktreeStore } from "../../lib/worktreeStore";
import {
	describeCommitAction,
	describeDiscard,
	type FileStatus,
	type GitCommitHint,
	stageFailureSummary,
} from "../../types/git";
import {
	describeGitFailure,
	type GitFailure,
	isHunkStale,
} from "../../utils/gitErrors";
import { splitPath } from "../../utils/path";
import PageHeader, { type PageBack } from "../Layout/PageHeader";
import {
	BottomActionBar,
	ContentView,
	getActionIconButtonClass,
	ToggleIconButton,
} from "../ui";
import { FileNameTitle } from "../ui/HeaderTitle";
import { isGutter, shownLineKeys } from "../ui/lineGutter";
import ConflictView, { useConflictFile } from "./ConflictView";
import DiffContent from "./DiffContent";
import ErrorBanner from "./ErrorBanner";
import GitCommitSheet from "./GitCommitSheet";
import HunkBar, { HUNK_BAR_ATTRIBUTE } from "./HunkBar";
import LineSelectionBar from "./LineSelectionBar";

interface Props {
	path: string;
	/** The side the route asks for; the file's other side stands in if it has only that. */
	staged: boolean;
	/**
	 * Whether the header offers the way back to the list. Not where that list
	 * is on screen beside it.
	 */
	showBack?: boolean;
}

interface Primary {
	label: string;
	onClick: () => void;
	enabled: boolean;
	hint?: GitCommitHint | null;
}

/**
 * A hunk bar's place on screen when its write answered, for the bar that
 * takes its place once the diff without it arrives.
 */
interface HunkAnchor {
	hunkId: string;
	index: number;
	/**
	 * The hunks beside it, the bar's successors by preference: by ID rather
	 * than by index, since hunks pressed in a row may leave together and an
	 * index in the old diff names a different hunk in the new one.
	 */
	next?: string;
	previous?: string;
	top: number;
	/** The snapshot count when it was taken. */
	snapshot: number;
	/**
	 * The diff it was taken in. The last hunk of a side leaving takes the page
	 * to the other side, whose hunks are not the ones it was held among.
	 */
	view: string;
	/**
	 * Whether focus was in the bar, which goes with the hunk: a keyboard user
	 * would be left on the page's body.
	 */
	focused: boolean;
}

/**
 * Frames to wait for the library to draw the new diff's bars, about a second:
 * it rebuilds the lines of a changed diff in an effect, and draws an
 * unwrapped extend row only once it has measured the table.
 */
const ANCHOR_FRAMES = 60;

/**
 * A selection as held: the range, what it was made over — a side, a
 * whitespace setting, a layout, any change of which clears it — and its rows'
 * content when it was made, which a refreshed diff has to match for it to stay.
 */
interface HeldSelection extends LineRange {
	scope: string;
	signature: string;
	/** Whether the anchor is the top end, kept when the rows are found again. */
	anchorFirst: boolean;
}

/**
 * What a click on the page leaves the line selection alone for: a control
 * does what it does, and a press there is never also a dismissal. The gap row
 * is one, its whole width expanding it.
 */
const INTERACTIVE =
	'button, a[href], input, textarea, select, label, summary, [role="button"], [role="checkbox"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"]), [contenteditable="true"], .diff-line-hunk';

const bottomButtonBase =
	"flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-4 text-sm transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The review layer: one changed file at a time, in the order the Changes list
 * draws them, with "stage and go on to the next" as its primary action
 * (docs/git-changes-ui.md#the-review-layer).
 *
 * A review is one history entry: every move inside it — to another file, to
 * the file's other side — replaces the route, carrying its history state, and
 * leaving it is `useLeaveReview`, so the list is one step behind it.
 */
function DiffView({ path, staged, showBack }: Props) {
	const navigate = useNavigate();
	const router = useRouter();
	const { worktree, sessionId } = useRouteState();
	const { hideWhitespace, toggleHideWhitespace } = useDiffSettings();
	const { wrap, toggleWrap } = useGitDiffWrap();
	const { available: splitAvailable, split, toggleSplit } = useGitDiffSplit();
	const { data: status, isPending: statusPending } = useGitStatus();
	const queryClient = useQueryClient();
	const view = useGitChangesViewStore((s) => s.view);
	const { toggle, resolve, toggleHunk, discard, writes } = useGitWriteRunner();
	// The worktree the runner sends to, read in the same render, as the Changes
	// list does: a failure is filed under the worktree whose path it names.
	const writeWorktree = useWorktreeStore((s) => s.current);
	const [error, setError] = useState<GitFailure | null>(null);
	// What the pressed write says while it is queued — kept from the press, as
	// a status landing first may already have changed the button under it.
	const [pendingLabel, setPendingLabel] = useState<string | null>(null);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	const [committing, setCommitting] = useState(false);
	const hintId = useId();

	const files = useMemo(
		() => (status ? orderChanges(collectChanges(status), view) : []),
		[status, view],
	);
	const file = files.find((f) => f.path === path);
	// Stopped being changed while on screen — committed or reverted by the
	// agent, say. The page stays and says so rather than being taken away.
	const gone = status !== undefined && !file;
	const side = file ? reviewSideOf(file, staged) : staged;
	const position = file ? files.indexOf(file) + 1 : null;
	const prev = adjacentChange(files, view, path, -1);
	const next = adjacentChange(files, view, path, 1);

	// A write answers after the press; by then the list may have changed, and
	// "next" is whatever sorts after this file *then*.
	const latest = useRef({ files, view });
	const wasDeleted = useRef(false);
	useLayoutEffect(() => {
		latest.current = { files, view };
		if (file) wasDeleted.current = changeKindOf(file) === "deleted";
	});
	// Set once this page has sent the reader to another file or to the list.
	// The route props still name this file until the router renders the move,
	// and the side-following below must not send them back meanwhile.
	const leaving = useRef(false);
	// GitWorkspace mounts one instance per path, so this is "the reader is still
	// on this file": a write answered after they moved on must not move them.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const conflict = file?.conflict;
	// A conflicted path has no diff to read: the index holds stages, not a
	// version (docs/git-conflict-ui.md#viewing-a-conflicted-file). Not asked
	// while the status that says whether it is one is still on its way — a
	// status that failed says nothing, and the diff is read as it always was.
	const {
		data: diff,
		isLoading,
		error: loadError,
		snapshot,
		refresh: refreshDiff,
		currentSnapshot,
	} = useGitDiffWatch({
		path,
		staged: side,
		hideWhitespace,
		enabled: !statusPending && !gone && !conflict,
	});
	const conflictFile = useConflictFile(path, conflict);

	const moveTo = useCallback(
		(target: { path: string; staged: boolean }) => {
			navigate({
				...overlayToNavigation(
					{ type: "diff", ...target },
					worktree,
					sessionId,
					{ replace: true },
				),
				state: true,
			});
		},
		[navigate, worktree, sessionId],
	);
	const goToFile = (target: ChangedFile) => {
		leaving.current = true;
		moveTo({ path: target.path, staged: reviewSideOf(target, false) });
	};
	const goToNextOrLeave = () => {
		const { files, view } = latest.current;
		const after = adjacentChange(files, view, path, 1);
		if (after) goToFile(after);
		else leave();
	};
	const leaveReview = useLeaveReview();
	const leave = () => {
		leaving.current = true;
		leaveReview(worktree, sessionId);
	};
	const back: PageBack | undefined = showBack
		? { to: "parent", label: "Back to changes", onClick: leave }
		: undefined;

	// The route follows to the side that still exists — after Stage, Unstage or
	// a change from elsewhere — so that it keeps naming what is on screen.
	useEffect(() => {
		if (!file || side === staged || leaving.current) return;
		// Sent elsewhere by someone else — the shell, moving the review on from
		// a file discarded in the list — and not rendered yet: the URL already
		// says so while these props do not.
		const here = router.buildLocation(
			overlayToNavigation({ type: "diff", path, staged }, worktree, sessionId),
		);
		if (router.latestLocation.pathname !== here.pathname) return;
		moveTo({ path, staged: side });
	}, [file, side, staged, path, moveTo, router, worktree, sessionId]);

	// Forgotten with the side it was for, so it cannot come back by itself if
	// the file changes again later.
	useEffect(() => {
		if (confirmingDiscard && !file?.unstaged) setConfirmingDiscard(false);
	}, [confirmingDiscard, file]);

	// Any pending write on this file, not just one started here: the write
	// store drops a path it is already writing, so a second press would report
	// a write that never happened.
	const isBusy = isPathWriting(writes, path);

	const report = (
		e: unknown,
		summary: () => string,
		paths: string[],
		{ withDetail = true } = {},
	) => {
		// A write dropped by a worktree switch says nothing about this file.
		if (e instanceof WorktreeChangedError) return;
		const failure = withDetail
			? describeGitFailure(e, summary)
			: { summary: summary(), detail: null };
		// Shown here while the file is on screen; once it is not, on the Changes
		// list's banner, which outlives the page — a failure that settled after
		// the reader left would otherwise be told to nobody.
		if (mounted.current) setError(failure);
		else gitWriteActions.fail(writeWorktree, { ...failure, paths });
	};

	const hunks = useMemo(
		() => (diff && !diff.omitted ? parseHunks(diff.diff) : []),
		[diff],
	);
	// A box stages the ID at its hunk's index, which the server accepts as long
	// as the ID is current: were its count and this parse ever to disagree, a
	// box would stage a hunk other than the one it is drawn under.
	const listedIds = diff && !diff.omitted ? diff.hunk_ids : undefined;
	const hunkIds = listedIds?.length === hunks.length ? listedIds : undefined;
	// Read when a write answers, which is later than the press's render.
	const latestHunkIds = useRef(hunkIds);
	useLayoutEffect(() => {
		latestHunkIds.current = hunkIds;
	});
	// Hunks whose write succeeded, with the latest snapshot count when it
	// answered. The write's slot ends with its answer while the diff comes back
	// separately, and pressing a hunk that is already staged would be refused
	// as stale, so it stays busy until a later snapshot — read after the write
	// — is on screen. A notification is no proof: it can have been on its way
	// before the write.
	const [written, setWritten] = useState<ReadonlyMap<string, number>>(
		() => new Map(),
	);
	const diffBodyRef = useRef<HTMLDivElement>(null);
	const anchor = useRef<HunkAnchor | null>(null);

	const holdPlace = (hunkId: string) => {
		const hunkIds = latestHunkIds.current ?? [];
		const index = hunkIds.indexOf(hunkId);
		const bar = diffBodyRef.current?.querySelector(
			`[${HUNK_BAR_ATTRIBUTE}="${index}"]`,
		);
		anchor.current = bar
			? {
					hunkId,
					index,
					next: hunkIds[index + 1],
					previous: hunkIds[index - 1],
					top: bar.getBoundingClientRect().top,
					snapshot: currentSnapshot(),
					view: `${path}\0${side}`,
					focused: bar.contains(document.activeElement),
				}
			: null;
	};

	// Once the hunk has left the diff, the bar that took its index — the next
	// hunk's, or the previous one's at the end — goes where it was, so a run
	// of presses walks down the file under a still thumb.
	useEffect(() => {
		const held = anchor.current;
		if (!held) return;
		if (held.view !== `${path}\0${side}`) {
			anchor.current = null;
			return;
		}
		if (hunkIds?.includes(held.hunkId)) {
			// Read after the write and still there — a stale refusal for a file
			// that has changed back — so there is no place to keep.
			if (snapshot > held.snapshot) anchor.current = null;
			return;
		}
		const ids = hunkIds ?? [];
		if (ids.length === 0) {
			anchor.current = null;
			return;
		}
		const byNeighbour = [held.next, held.previous]
			.map((id) => (id ? ids.indexOf(id) : -1))
			.find((index) => index >= 0);
		const target = byNeighbour ?? Math.min(held.index, ids.length - 1);
		let frame = 0;
		let request = requestAnimationFrame(function place() {
			const body = diffBodyRef.current;
			const bar = body?.querySelector(`[${HUNK_BAR_ATTRIBUTE}="${target}"]`);
			// The bars are drawn by the library after the diff renders, in rows
			// it lays out over a frame or two.
			if (!bar) {
				if (++frame < ANCHOR_FRAMES) request = requestAnimationFrame(place);
				else anchor.current = null;
				return;
			}
			// Let go only once placed: a notification landing while the bars are
			// still being drawn reruns this, and has to find the place still held.
			anchor.current = null;
			const scroller = body?.parentElement;
			if (scroller) {
				scroller.scrollTop += bar.getBoundingClientRect().top - held.top;
			}
			if (held.focused) {
				bar
					.querySelector<HTMLElement>('[role="checkbox"]')
					?.focus({ preventScroll: true });
			}
		});
		return () => cancelAnimationFrame(request);
	}, [hunkIds, snapshot, path, side]);

	const handleHunk = async (hunkId: string) => {
		const staged = side;
		setError(null);
		try {
			await toggleHunk(path, hunkId, staged);
			gitWriteActions.succeed(writeWorktree, [path]);
			if (!mounted.current) return;
			setWritten((current) => new Map(current).set(hunkId, currentSnapshot()));
			holdPlace(hunkId);
			refreshDiff();
		} catch (e) {
			if (!isHunkStale(e)) {
				report(e, () => stageFailureSummary(staged), [path]);
				return;
			}
			// Nothing failed that the reader could act on, and nothing was
			// written: the hunk they decided about is gone, and whatever sits in
			// its place now is theirs to decide about again — so no retry.
			report(
				e,
				() =>
					`This part of the file changed before it could be ${staged ? "unstaged" : "staged"}.`,
				[path],
				{ withDetail: false },
			);
			if (!mounted.current) return;
			holdPlace(hunkId);
			refreshDiff();
		}
	};

	// Through a ref so that the bars below change only with what they show:
	// a new `renderHunkBar` on every render would redraw the whole diff's
	// extend rows on each status poll and every write anywhere.
	const pressHunk = useRef(handleHunk);
	useLayoutEffect(() => {
		pressHunk.current = handleHunk;
	});
	const pendingHunks = writes.hunks.get(path);
	const fileWriting = writes.toggling.has(path) || writes.discarding.has(path);
	const renderHunkBar = useCallback(
		(hunk: DiffHunk, index: number) => {
			const hunkId = hunkIds?.[index];
			const busy =
				hunkId !== undefined &&
				(fileWriting ||
					!!pendingHunks?.has(hunkId) ||
					(written.get(hunkId) ?? -1) >= snapshot);
			return (
				<HunkBar
					hunk={hunk}
					index={index}
					staged={side}
					onSelect={() => pressSelect.current(index)}
					stage={
						hunkId
							? { busy, onToggle: () => pressHunk.current(hunkId) }
							: undefined
					}
				/>
			);
		},
		[hunkIds, side, fileWriting, pendingHunks, written, snapshot],
	);

	// Lines selected for Copy and Ask AI (docs/git-changes-ui.md#handing-lines-to-the-agent).
	const prefill = usePrefillComposer();
	const rows = useMemo(
		() =>
			diff && !diff.omitted
				? buildDiffRows(hunks, {
						old: diff.old_content,
						new: diff.new_content,
					})
				: [],
		[diff, hunks],
	);
	const scope = `${side}|${hideWhitespace}|${split}|${gone}`;
	const [held, setHeld] = useState<HeldSelection | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const selection = useMemo(() => {
		if (!held || held.scope !== scope) return null;
		const found = relocateRange(rows, held, held.signature, held.anchorFirst);
		if (!found) return null;
		return {
			...found,
			description: describeRange(found.selected, held.view),
		};
	}, [held, rows, scope]);
	// A refreshed diff that no longer has every selected row as it was — the
	// agent edited them, or their hunk was staged — takes the selection with
	// it; a new side, setting or layout does too, without needing saying. No
	// diff at all is a connection being re-established, which says nothing
	// about the file: the selection waits for the diff to come back.
	useEffect(() => {
		// Found again under other keys: held under those, so the next refresh
		// takes the quick path instead of searching the file once more.
		if (
			held &&
			selection &&
			(selection.range.anchor !== held.anchor ||
				selection.range.focus !== held.focus)
		) {
			setHeld({
				...held,
				anchor: selection.range.anchor,
				focus: selection.range.focus,
			});
			return;
		}
		if (!held || selection) return;
		if (held.scope !== scope) {
			setHeld(null);
			return;
		}
		if (!diff) return;
		setHeld(null);
		setAnnouncement("Selection cleared — the file changed");
	}, [held, selection, scope, diff]);

	const barRef = useRef<HTMLDivElement>(null);
	const copyRef = useRef<HTMLButtonElement>(null);
	const focusCopy = useRef(false);
	const select = (range: LineRange | null, by: "pointer" | "button") => {
		const selected = range && resolveRange(rows, range);
		if (!range || !selected) {
			setHeld(null);
			return;
		}
		setHeld({
			view: range.view,
			anchor: range.anchor,
			focus: range.focus,
			scope,
			signature: rangeSignature(selected, range.view),
			anchorFirst: rowKey(selected[0], range.view) === range.anchor,
		});
		// A press in the gutter moves no focus, so it is said; the hunk bar's
		// Select takes focus to the bar, which says it there.
		if (by === "pointer") {
			const { label } = describeRange(selected, range.view);
			setAnnouncement(`${capitalize(label)} selected`);
		} else {
			focusCopy.current = true;
		}
	};
	useEffect(() => {
		if (!selection || !focusCopy.current) return;
		focusCopy.current = false;
		copyRef.current?.focus();
	}, [selection]);

	// When the bar goes while it holds focus — ✕, Escape, a refresh — focus
	// goes back to the Select button of the hunk the selection was in, rather
	// than to the page's body. Tracked by focus events because by the time the
	// bar is gone, so is the element that had focus.
	const barHasFocus = useRef(false);
	const selectionHunk = useRef(0);
	useLayoutEffect(() => {
		if (!selection) return;
		// The hunk the selection is in, or the last one before it — a range of
		// unchanged lines only is in none.
		const start = rows.indexOf(selection.selected[0]);
		const inHunk =
			selection.selected.find((row) => row.hunk !== undefined) ??
			rows
				.slice(0, Math.max(start, 0))
				.findLast((row) => row.hunk !== undefined);
		selectionHunk.current = inHunk?.hunk ?? 0;
	});
	useEffect(() => {
		if (selection || !barHasFocus.current) return;
		barHasFocus.current = false;
		let frame = 0;
		let request = requestAnimationFrame(function restore() {
			// Only while focus is nowhere: a late frame must not take it from
			// wherever the reader has gone since.
			const { activeElement } = document;
			if (activeElement && activeElement !== document.body) return;
			// By index, not by place: unwrapped split view draws each bar in the
			// table of its side, so the page's order is not the hunks'. The hunk
			// may have left with the change that cleared the selection.
			const indices = [
				...(diffBodyRef.current?.querySelectorAll(`[${HUNK_BAR_ATTRIBUTE}]`) ??
					[]),
			].map((bar) => Number(bar.getAttribute(HUNK_BAR_ATTRIBUTE)));
			const wanted = selectionHunk.current;
			const index =
				indices.filter((i) => i <= wanted).sort((a, b) => b - a)[0] ??
				Math.min(...indices);
			const button = diffBodyRef.current?.querySelector<HTMLElement>(
				`[${HUNK_BAR_ATTRIBUTE}="${index}"] button[aria-label^="Select "]`,
			);
			// Kept where it is: the reader is looking at the selection, which
			// may be far from its hunk's bar.
			if (button) button.focus({ preventScroll: true });
			else if (++frame < ANCHOR_FRAMES) {
				request = requestAnimationFrame(restore);
			}
		});
		return () => cancelAnimationFrame(request);
	}, [selection]);

	// Through refs, like `pressHunk`, so the diff is not redrawn for them.
	const pressLine = useRef((_: LinePress) => {});
	const pressSelect = useRef((_: number) => {});
	useLayoutEffect(() => {
		pressLine.current = (press) =>
			select(applyPress(selection?.range ?? null, press), "pointer");
		pressSelect.current = (index) =>
			select(hunkLineRange(rows, index, split), "button");
	});
	const onLinePress = useCallback(
		(press: LinePress) => pressLine.current(press),
		[],
	);
	const selectedLines = useMemo(
		() =>
			selection && {
				view: selection.range.view,
				keys: new Set(
					selection.selected.map(
						(row) => rowKey(row, selection.range.view) ?? "",
					),
				),
			},
		[selection],
	);

	// The bar has no backdrop, so it follows the conventions for an overlay
	// without one (docs/answering-ui.md): it claims the Escape and the click it
	// clears on, and stands down for whatever is drawn over the page.
	const isPageCovered = useIsPageCovered();
	const covered = useRef(isPageCovered);
	covered.current = isPageCovered;
	const hasSelection = selection !== null;
	useEffect(() => {
		if (!hasSelection) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (covered.current) return;
			event.preventDefault();
			setHeld(null);
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [hasSelection]);
	useOutsideClick(hasSelection, (target, event) => {
		if (covered.current || !target.isConnected) return;
		if (barRef.current?.contains(target)) return;
		if (isGutter(target) || target.closest(INTERACTIVE)) return;
		event.stopPropagation();
		setHeld(null);
	});

	const copySelection = () => {
		if (!selection || !diff || diff.omitted) return "";
		return selectionCopyText(selection.description, selection.selected, {
			old: diff.old_content,
			new: diff.new_content,
		});
	};
	const askAgent = () => {
		if (!selection) return;
		const { view } = selection.range;
		const body = diffBodyRef.current;
		// Read from the page: a gap the reader has not expanded is lines they
		// have not read, and the draft says how many rather than quoting them.
		const shown = body ? shownLineKeys(body, view) : null;
		void prefill.prefill(
			selectionPrefillText({
				path,
				selected: selection.selected,
				view,
				description: selection.description,
				staged: side,
				isShown: (row) =>
					row.hunk !== undefined ||
					!shown ||
					shown.has(rowKey(row, view) ?? ""),
			}),
		);
	};

	const handleStage = async () => {
		setError(null);
		setPendingLabel("Staging…");
		try {
			await toggle([path], false);
			gitWriteActions.succeed(writeWorktree, [path]);
			if (!mounted.current) return;
			// The last file stays: the reader sees it go staged and the commit
			// button appear, and a failure is never hidden behind a sheet.
			const { files, view } = latest.current;
			const after = adjacentChange(files, view, path, 1);
			if (after) goToFile(after);
		} catch (e) {
			report(e, () => stageFailureSummary(false), [path]);
		} finally {
			if (mounted.current) setPendingLabel(null);
		}
	};

	// The review's Stage by another name, and it stays: the file stops being
	// conflicted, and this page becomes the resolution's ordinary review.
	const handleMarkResolved = async () => {
		setError(null);
		setPendingLabel("Marking…");
		try {
			// The re-read shows the markers it found; there is nothing to stage.
			if (!(await conflictFile.confirmResolvable())) return;
			await resolve([path]);
			gitWriteActions.succeed(writeWorktree, [path]);
		} catch (e) {
			report(e, () => stageFailureSummary(false), [path]);
		} finally {
			if (mounted.current) setPendingLabel(null);
		}
	};

	const handleAskAgent = () => {
		const text = operationPromptAtPress(queryClient);
		if (text) void prefill.prefill(text);
	};

	const handleUnstage = async (target: ChangedFile) => {
		setError(null);
		const paths = unstagePaths(target);
		try {
			await toggle(paths, true);
			gitWriteActions.succeed(writeWorktree, paths);
		} catch (e) {
			report(e, () => stageFailureSummary(true), paths);
		}
	};

	const handleDiscard = async (target: FileStatus) => {
		setConfirmingDiscard(false);
		setError(null);
		try {
			await discard([path]);
			gitWriteActions.succeed(writeWorktree, [path]);
			// The discarded side has nothing left to review.
			if (mounted.current) goToNextOrLeave();
		} catch (e) {
			report(e, () => describeDiscard([target]).failureSummary, [path]);
		}
	};

	const commitAction = describeCommitAction(status);
	// Offered only once the text has no marker left, so it cannot record
	// markers as a resolution. Kept through its own press, whose re-read would
	// otherwise put another button under the spinner — a conflict has no other
	// write to be pending.
	const offerResolve =
		conflictFile.resolvable ||
		(conflict === "content" && pendingLabel !== null);
	const primary: Primary | null = offerResolve
		? {
				label: "Mark resolved",
				onClick: handleMarkResolved,
				enabled: !isBusy && pendingLabel === null,
			}
		: conflict
			? next
				? { label: "Next", onClick: () => goToFile(next), enabled: true }
				: { label: "Back to changes", onClick: leave, enabled: true }
			: file?.unstaged
				? {
						label: next ? "Stage & next" : "Stage",
						onClick: handleStage,
						enabled: !isBusy,
					}
				: next
					? { label: "Next", onClick: () => goToFile(next), enabled: true }
					: commitAction
						? {
								label: commitAction.label,
								onClick: () => setCommitting(true),
								enabled: commitAction.enabled,
								hint: commitAction.hint,
							}
						: gone
							? { label: "Back to changes", onClick: leave, enabled: true }
							: null;

	const untracked = file?.unstaged?.status === "?";
	// Still deleted once the deletion is committed and the file has left the
	// list: there is nothing to open either way.
	const deleted = file ? changeKindOf(file) === "deleted" : wasDeleted.current;
	const openFile = () =>
		navigate(overlayToNavigation({ type: "file", path }, worktree, sessionId));
	const { fileName, directory } = splitPath(path);
	const dir = directory.replace(/\/$/, "");
	const total = files.length;

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<PageHeader
				back={back}
				title={<FileNameTitle name={fileName} />}
				fullText={path}
				onTitleClick={deleted ? undefined : openFile}
				titleActionLabel={deleted ? undefined : `Open ${fileName}`}
			/>

			<div className="flex min-h-[44px] shrink-0 items-center gap-1 border-b border-th-border px-2 pointer-coarse:gap-2">
				<button
					type="button"
					disabled={!prev}
					onClick={() => prev && goToFile(prev)}
					className={getActionIconButtonClass(!!prev)}
					aria-label="Previous file"
				>
					<ChevronLeft className="h-4 w-4" aria-hidden="true" />
				</button>
				{status && (
					<span className="shrink-0 px-1 text-xs tabular-nums text-th-text-muted">
						<span aria-hidden="true">
							{position ?? "–"} / {total}
						</span>
						<span className="sr-only">
							{position
								? `File ${position} of ${total}`
								: `No longer changed, ${total} changed files`}
						</span>
					</span>
				)}
				<button
					type="button"
					disabled={!next}
					onClick={() => next && goToFile(next)}
					className={getActionIconButtonClass(!!next)}
					aria-label="Next file"
				>
					<ChevronRight className="h-4 w-4" aria-hidden="true" />
				</button>
				{/* The one part that gives way: from the head, since the deepest
				    folder is what tells files apart. `bdi` keeps rtl from
				    reordering the path. */}
				<span className="min-w-0 flex-1 truncate px-1 text-xs text-th-text-muted [direction:rtl]">
					<bdi>{dir}</bdi>
				</span>
				<ToggleIconButton
					icon={WrapText}
					pressed={wrap}
					onClick={toggleWrap}
					label={wrap ? "Don't wrap lines" : "Wrap lines"}
				/>
				{/* A conflict is the file, not a diff: nothing to filter or split. */}
				{!conflict && (
					<ToggleIconButton
						icon={ALargeSmall}
						pressed={hideWhitespace}
						onClick={toggleHideWhitespace}
						label={
							hideWhitespace
								? "Show whitespace changes"
								: "Hide whitespace changes"
						}
					/>
				)}
				{splitAvailable && !conflict && (
					<ToggleIconButton
						icon={Columns2}
						pressed={split}
						onClick={toggleSplit}
						label={split ? "Inline" : "Side by side"}
					/>
				)}
			</div>

			{file?.staged && file.unstaged && (
				<div className="flex min-h-[44px] shrink-0 items-center gap-2 border-b border-th-border px-3">
					<span className="min-w-0 flex-1 truncate text-xs text-th-text-muted">
						Partly staged
					</span>
					<fieldset
						aria-label="Which part of the file to show"
						className="flex min-w-0 shrink-0 gap-0.5 rounded-md bg-th-bg-tertiary p-0.5 pointer-coarse:gap-2"
					>
						{[
							{ label: "Unstaged", staged: false },
							{ label: "Staged", staged: true },
						].map((option) => (
							<button
								key={option.label}
								type="button"
								aria-pressed={side === option.staged}
								onClick={() => moveTo({ path, staged: option.staged })}
								className={`min-h-9 rounded px-3 text-xs transition-colors pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
									side === option.staged
										? "bg-th-bg-primary font-medium text-th-text-primary"
										: "text-th-text-muted hover:text-th-text-primary"
								}`}
							>
								{option.label}
							</button>
						))}
					</fieldset>
				</div>
			)}

			{error && (
				<ErrorBanner
					summary={error.summary}
					details={error.detail}
					onDismiss={() => setError(null)}
				/>
			)}
			{prefill.error && (
				<ErrorBanner
					summary={prefill.error.summary}
					details={prefill.error.detail}
					onDismiss={prefill.dismissError}
				/>
			)}
			<p className="sr-only" aria-live="polite">
				{announcement}
			</p>
			{conflict ? (
				<ConflictView
					path={path}
					conflict={conflict}
					file={conflictFile}
					wrap={wrap}
					onOpenFile={openFile}
				/>
			) : gone ? (
				<div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-th-text-muted">
					This file no longer has changes
				</div>
			) : (
				<ContentView isLoading={isLoading} error={loadError}>
					{diff !== undefined && (
						<div ref={diffBodyRef}>
							{hideWhitespace &&
								!diff.omitted &&
								/^@@ /m.test(diff.diff) &&
								!(file && stagesOnlyWhole(file, side)) && (
									<div className="flex flex-wrap items-center gap-x-2 px-3 py-1 text-xs text-th-text-muted">
										<span>Show whitespace to stage parts of this file</span>
										<button
											type="button"
											onClick={toggleHideWhitespace}
											className="inline-flex min-h-9 items-center rounded px-2 text-th-accent hover:underline pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
										>
											Show whitespace
										</button>
									</div>
								)}
							<DiffContent
								data={diff}
								fileName={path}
								split={split}
								renderHunkBar={renderHunkBar}
								onLinePress={onLinePress}
								selectedLines={selectedLines}
							/>
						</div>
					)}
				</ContentView>
			)}

			{selection && (
				<LineSelectionBar
					label={capitalize(selection.description.label)}
					copyText={copySelection}
					onAsk={askAgent}
					asking={prefill.isPending}
					onClear={() => setHeld(null)}
					onFocusChange={(focused) => {
						barHasFocus.current = focused;
					}}
					copyRef={copyRef}
					barRef={barRef}
				/>
			)}

			{(file || primary) && (
				<BottomActionBar>
					{/* Above the buttons, as on the list's bar: a line under them is
					    the first thing an on-screen keyboard covers. */}
					{primary?.hint && (
						<span
							id={hintId}
							className={
								primary.hint.alreadyOnScreen
									? "sr-only"
									: "mb-1.5 block text-xs text-th-text-muted"
							}
						>
							{primary.hint.text}
						</span>
					)}
					{/* A gap between the two, so the one that takes something away is
					    not flush against the one pressed all day. */}
					<div className="flex gap-3">
						{/* A conflict has neither side to unstage or discard: git
						    refuses to restore an unmerged path, and resetting one
						    would throw its conflict away. The handoff takes the
						    secondary's place; the banner's primary is one Back away. */}
						{conflict ? (
							<button
								type="button"
								onClick={handleAskAgent}
								disabled={prefill.isPending}
								aria-label="Ask agent to resolve the conflicts"
								className={`${bottomButtonBase} max-w-[50%] shrink-0 bg-th-bg-tertiary text-th-text-primary`}
							>
								{prefill.isPending ? (
									<Loader2
										className="h-4 w-4 shrink-0 animate-spin"
										aria-hidden="true"
									/>
								) : (
									<Sparkles className="h-4 w-4 shrink-0" aria-hidden="true" />
								)}
								Ask agent
							</button>
						) : (
							file &&
							(side ? (
								<button
									type="button"
									onClick={() => handleUnstage(file)}
									disabled={isBusy}
									className={`${bottomButtonBase} max-w-[40%] shrink-0 bg-th-bg-tertiary text-th-text-primary`}
								>
									Unstage
								</button>
							) : (
								<button
									type="button"
									onClick={() => setConfirmingDiscard(true)}
									disabled={isBusy}
									className={`${bottomButtonBase} max-w-[40%] shrink-0 bg-th-bg-tertiary text-th-error`}
								>
									{untracked ? "Delete file" : "Discard file"}
								</button>
							))
						)}
						{primary && (
							<button
								type="button"
								onClick={primary.onClick}
								disabled={!primary.enabled}
								aria-describedby={primary.hint ? hintId : undefined}
								className={`${bottomButtonBase} min-w-0 flex-1 bg-th-accent font-medium text-th-accent-text`}
							>
								{pendingLabel ? (
									<>
										<Loader2
											className="h-4 w-4 shrink-0 animate-spin"
											aria-hidden="true"
										/>
										{pendingLabel}
									</>
								) : (
									primary.label
								)}
							</button>
						)}
					</div>
				</BottomActionBar>
			)}

			{/* Read from the live file: a confirmation for a side that has gone
			    meanwhile would discard nothing and report a failure. */}
			{confirmingDiscard && file?.unstaged && (
				<DiscardConfirm
					file={file.unstaged}
					onConfirm={() => file.unstaged && handleDiscard(file.unstaged)}
					onCancel={() => setConfirmingDiscard(false)}
				/>
			)}

			{/* A sibling of the bar, not inside it: a refresh that changes the
			    buttons must not unmount a half-written message. */}
			{committing && (
				<GitCommitSheet
					amendInitially={false}
					onClose={() => setCommitting(false)}
					// What the reader came to do is done; files left unstaged are
					// waiting in the list.
					onCommitted={leave}
				/>
			)}
		</div>
	);
}

function DiscardConfirm({
	file,
	onConfirm,
	onCancel,
}: {
	file: FileStatus;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { title, message, confirmLabel } = describeDiscard([file]);
	return (
		<ConfirmDialog
			title={title}
			message={message}
			confirmLabel={confirmLabel}
			variant="danger"
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
}

export default DiffView;
