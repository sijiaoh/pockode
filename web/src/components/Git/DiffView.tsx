import { ConfirmDialog } from "@pockode/shared";
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
	unstagePaths,
} from "../../lib/gitChanges";
import { useGitChangesViewStore } from "../../lib/gitChangesViewStore";
import { gitWriteActions, WorktreeChangedError } from "../../lib/gitWriteStore";
import { overlayToNavigation } from "../../lib/navigation";
import { useWorktreeStore } from "../../lib/worktreeStore";
import {
	describeCommitAction,
	describeDiscard,
	type FileStatus,
	type GitCommitHint,
	stageFailureSummary,
} from "../../types/git";
import { describeGitFailure, type GitFailure } from "../../utils/gitErrors";
import { splitPath } from "../../utils/path";
import PageHeader, { type PageBack } from "../Layout/PageHeader";
import {
	BottomActionBar,
	ContentView,
	getActionIconButtonClass,
	ToggleIconButton,
} from "../ui";
import { FileNameTitle } from "../ui/HeaderTitle";
import ConflictView, { useConflictFile } from "./ConflictView";
import DiffContent from "./DiffContent";
import ErrorBanner from "./ErrorBanner";
import GitCommitSheet from "./GitCommitSheet";

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
	const { toggle, resolve, discard, writes } = useGitWriteRunner();
	// The worktree the runner sends to, read in the same render, as the Changes
	// list does: a failure is filed under the worktree whose path it names.
	const writeWorktree = useWorktreeStore((s) => s.current);
	const [error, setError] = useState<GitFailure | null>(null);
	// What the pressed write says while it is queued — kept from the press, as
	// a status landing first may already have changed the button under it.
	const [pendingLabel, setPendingLabel] = useState<string | null>(null);
	const handoff = usePrefillComposer();
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
	const { data: diff, isLoading } = useGitDiffWatch({
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
	const isBusy = writes.toggling.has(path) || writes.discarding.has(path);

	const report = (e: unknown, summary: () => string, paths: string[]) => {
		// A write dropped by a worktree switch says nothing about this file.
		if (e instanceof WorktreeChangedError) return;
		const failure = describeGitFailure(e, summary);
		// Shown here while the file is on screen; once it is not, on the Changes
		// list's banner, which outlives the page — a failure that settled after
		// the reader left would otherwise be told to nobody.
		if (mounted.current) setError(failure);
		else gitWriteActions.fail(writeWorktree, { ...failure, paths });
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
		if (text) void handoff.prefill(text);
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
			{handoff.error && (
				<ErrorBanner
					summary={handoff.error.summary}
					details={handoff.error.detail}
					onDismiss={handoff.dismissError}
				/>
			)}
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
				<ContentView isLoading={isLoading}>
					{diff !== undefined && (
						<DiffContent data={diff} fileName={path} split={split} />
					)}
				</ContentView>
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
								disabled={handoff.isPending}
								aria-label="Ask agent to resolve the conflicts"
								className={`${bottomButtonBase} max-w-[50%] shrink-0 bg-th-bg-tertiary text-th-text-primary`}
							>
								{handoff.isPending ? (
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
