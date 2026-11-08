import { ConfirmDialog } from "@pockode/shared";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	type FocusEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitWriteRunner } from "../../hooks/useGitWrites";
import { useOrderedChanges } from "../../hooks/useOrderedChanges";
import { useRouteState } from "../../hooks/useRouteState";
import {
	adjacentChange,
	buildChangeTree,
	type ChangedFile,
	type ChangeFolder,
	type ChangesView,
	filesUnder,
	groupChanges,
	reviewSideOf,
	sumLines,
	unstagePaths,
} from "../../lib/gitChanges";
import {
	gitChangesViewActions,
	useCollapsedFolders,
} from "../../lib/gitChangesViewStore";
import {
	type GitWrites,
	gitWriteActions,
	isPathWriting,
	useWriteFailure,
	WorktreeChangedError,
} from "../../lib/gitWriteStore";
import { overlayToNavigation } from "../../lib/navigation";
import { useWorktreeStore } from "../../lib/worktreeStore";
import {
	describeDiscard,
	type FileStatus,
	stageFailureSummary,
} from "../../types/git";
import { fileHistoryOverlay } from "../../types/overlay";
import { describeGitFailure } from "../../utils/gitErrors";
import { Spinner } from "../ui";
import ChangedFileMenu from "./ChangedFileMenu";
import ChangedFileRow, { TREE_INDENT } from "./ChangedFileRow";
import ChangesHeader from "./ChangesHeader";
import CommitBar from "./CommitBar";
import ErrorBanner from "./ErrorBanner";
import LineCounts from "./LineCounts";
import { useRevealLitRow } from "./revealRow";
import StageButton, { StageGutter } from "./StageButton";

interface Props {
	onSelectFile: (path: string, staged: boolean) => void;
	/**
	 * Takes the review off `path` in `worktree`, just discarded, and on to
	 * `next` — or to the list when nothing follows — if that review is still
	 * the page. Both are named because the discard is answered later than it
	 * was asked: by then the screen may be somewhere else, even in another
	 * worktree.
	 */
	onCloseFile: (
		path: string,
		worktree: string,
		next: { path: string; staged: boolean } | null,
	) => void;
	activeFile: { path: string; staged: boolean } | null;
	/** Set while the lit row is wanted on screen; called once it is. */
	reveal?: () => void;
	/**
	 * Takes `History of this file` in place of navigating to that list: set
	 * where the route names a page the list must leave alone (the sidebar's
	 * list at `expanded`, beside anything but the bare list).
	 */
	onShowFileHistory?: (path: string) => void;
}

/**
 * The working tree's changes in groups — Conflicts, Unstaged, Staged — a row
 * per path and side, under a header that totals them and over the commit bar
 * that commits what is staged and discards what is not — the Git workspace's
 * Changes segment (docs/git-changes-ui.md).
 */
function ChangesSection({
	onSelectFile,
	onCloseFile,
	activeFile,
	reveal,
	onShowFileHistory,
}: Props) {
	const navigate = useNavigate();
	const { worktree: routeWorktree, sessionId } = useRouteState();
	const { data: status, isLoading, error } = useGitStatus();
	const { toggle, discard, writes } = useGitWriteRunner();
	// The files a confirmation is currently open for; null when none is.
	const [pendingDiscard, setPendingDiscard] = useState<FileStatus[] | null>(
		null,
	);
	// By path, so the sheet follows the file through refreshes — and goes
	// when the file stops having changes — and by the group it was opened
	// from, which decides whether it offers a discard.
	const [menu, setMenu] = useState<{ path: string; staged: boolean } | null>(
		null,
	);
	// The worktree the runner sends to, read in the same render, so a failure
	// is filed under the worktree whose paths it names.
	const worktree = useWorktreeStore((s) => s.current);
	const actionError = useWriteFailure(worktree);
	const { files, view } = useOrderedChanges(status);
	const groups = useMemo(() => groupChanges(files), [files]);
	const scrollerRef = useRef<HTMLDivElement>(null);
	useRevealLitRow(scrollerRef, reveal);

	// A discard answers after the press; what follows a file then is read from
	// the list as it is then.
	const latest = useRef({ files, view });
	useLayoutEffect(() => {
		latest.current = { files, view };
	});

	const stageRows = useCallback(
		async (rows: ChangedFile[], staged: boolean) => {
			const paths = staged
				? rows.flatMap(unstagePaths)
				: rows.map((f) => f.path);
			if (paths.length === 0) return false;
			try {
				await toggle(paths, staged);
				gitWriteActions.succeed(worktree, paths);
				return true;
			} catch (e) {
				if (e instanceof WorktreeChangedError) return false;
				gitWriteActions.fail(worktree, {
					...describeGitFailure(e, () => stageFailureSummary(staged)),
					paths,
				});
				return false;
			}
		},
		[toggle, worktree],
	);

	const runDiscard = useCallback(
		async (targets: FileStatus[]) => {
			const paths = targets.map((f) => f.path);
			setPendingDiscard(null);
			try {
				await discard(paths);
				gitWriteActions.succeed(worktree, paths);
				// A file discarded is done with, as the review's own Discard treats
				// it: one under review moves on. Every path, not the one open when
				// the discard was confirmed: the reader may have opened another of
				// them since, and only the shell knows what the page is now.
				//
				// What follows is read from a list that may not have heard of the
				// discard yet, so what it did is applied by hand: the files it left
				// without changes — nothing staged — are passed over, and the rest
				// have only their staged side left.
				const discarded = new Set(paths);
				const { files, view } = latest.current;
				const remaining = files.filter(
					(f) => f.staged || !discarded.has(f.path),
				);
				for (const path of paths) {
					const next = adjacentChange(remaining, view, path, 1);
					onCloseFile(
						path,
						worktree,
						next && {
							path: next.path,
							staged: discarded.has(next.path) || reviewSideOf(next, false),
						},
					);
				}
			} catch (e) {
				// Nothing was written, so there is nothing to report.
				if (e instanceof WorktreeChangedError) return;
				gitWriteActions.fail(worktree, {
					...describeGitFailure(
						e,
						() => describeDiscard(targets).failureSummary,
					),
					paths,
				});
			}
		},
		[discard, worktree, onCloseFile],
	);

	const menuFile = menu
		? (files.find((f) => f.path === menu.path) ?? null)
		: null;
	// Forgotten once the file is gone, so that the sheet does not come back by
	// itself if the same path changes again later.
	useEffect(() => {
		if (menu && !menuFile) setMenu(null);
	}, [menu, menuFile]);
	const closeMenu = useCallback(() => setMenu(null), []);
	const openMenu = useCallback(
		(path: string, staged: boolean) => setMenu({ path, staged }),
		[],
	);

	const openFile = useCallback(
		(path: string) => {
			setMenu(null);
			navigate(
				overlayToNavigation({ type: "file", path }, routeWorktree, sessionId),
			);
		},
		[navigate, routeWorktree, sessionId],
	);

	const openHistory = useCallback(
		(path: string) => {
			setMenu(null);
			if (onShowFileHistory) {
				onShowFileHistory(path);
				return;
			}
			navigate(
				overlayToNavigation(fileHistoryOverlay(path), routeWorktree, sessionId),
			);
		},
		[navigate, routeWorktree, sessionId, onShowFileHistory],
	);

	const discardFile = useCallback((file: ChangedFile) => {
		setMenu(null);
		if (file.unstaged) setPendingDiscard([file.unstaged]);
	}, []);

	// The Unstaged group's sides: a partly staged file keeps what is staged.
	const unstaged = useMemo(
		() => groups.unstaged.flatMap((f) => (f.unstaged ? [f.unstaged] : [])),
		[groups],
	);
	const partlyStaged = useMemo(() => {
		const staged = new Set(groups.staged.map((f) => f.path));
		return new Set(
			groups.unstaged.filter((f) => staged.has(f.path)).map((f) => f.path),
		);
	}, [groups]);
	const busy = files.some((f) => isPathWriting(writes, f.path));

	const groupProps: GroupProps = {
		view,
		worktree,
		activeFile,
		writes,
		onStage: stageRows,
		partlyStaged,
		onSelect: onSelectFile,
		onMore: openMenu,
	};

	return (
		<>
			{actionError && (
				<ErrorBanner
					summary={actionError.summary}
					details={actionError.detail}
					onDismiss={() => gitWriteActions.dismissFailure(worktree)}
				/>
			)}

			{/* No vertical padding here: the sticky header pins to this box's
			    padding edge, and would leave a gap above it for rows to show
			    through. */}
			<div
				ref={scrollerRef}
				className="@container min-h-0 flex-1 overflow-y-auto"
			>
				{isLoading ? (
					<div className="flex items-center justify-center p-8">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				) : error ? (
					<div className="p-4 text-center text-th-error">
						<div>Failed to load git status</div>
						<div className="mt-1 text-sm text-th-text-muted">
							{error instanceof Error ? error.message : String(error)}
						</div>
					</div>
				) : files.length === 0 ? (
					<div className="p-8 text-center text-sm text-th-text-muted">
						No changes
					</div>
				) : (
					<>
						<ChangesHeader
							files={files}
							view={view}
							onChangeView={gitChangesViewActions.setView}
						/>
						{/* Unstaged before Staged: new work appears there and review
						    starts there, and Staged sits right above Commit, which
						    takes it. */}
						<div className="flex flex-col gap-2 px-2 py-2">
							{groups.conflicts.length > 0 && (
								<ChangeGroup
									kind="conflicts"
									rows={groups.conflicts}
									{...groupProps}
								/>
							)}
							<ChangeGroup
								kind="unstaged"
								rows={groups.unstaged}
								{...groupProps}
							/>
							<ChangeGroup kind="staged" rows={groups.staged} {...groupProps} />
						</div>
					</>
				)}
			</div>

			<CommitBar
				discardUnstaged={
					groups.unstaged.length + groups.staged.length > 0
						? {
								onDiscard: () => setPendingDiscard(unstaged),
								busy,
								nothingUnstaged: unstaged.length === 0,
							}
						: null
				}
			/>

			{menu && menuFile && (
				<ChangedFileMenu
					file={menuFile}
					onClose={closeMenu}
					onOpenFile={openFile}
					onOpenHistory={openHistory}
					// From the row, not the file: a partly staged file's Staged row
					// has nothing to discard.
					onDiscard={menu.staged ? undefined : discardFile}
					busy={isPathWriting(writes, menuFile.path)}
				/>
			)}

			{pendingDiscard && (
				<DiscardConfirm
					files={pendingDiscard}
					// The pending batch holds unstaged sides only, which cannot say
					// whether the file has a staged one; the live list can.
					keepsStaged={
						pendingDiscard.length === 1 &&
						files.some((f) => f.path === pendingDiscard[0].path && f.staged)
					}
					onConfirm={() => {
						runDiscard(pendingDiscard);
					}}
					onCancel={() => setPendingDiscard(null)}
				/>
			)}
		</>
	);
}

type GroupKind = "conflicts" | "unstaged" | "staged";

const GROUP_NAME: Record<GroupKind, string> = {
	conflicts: "Conflicts",
	unstaged: "Unstaged",
	staged: "Staged",
};

const GROUP_EMPTY = {
	unstaged: "No unstaged changes.",
	staged: "No staged changes.",
};

interface GroupProps {
	view: ChangesView;
	worktree: string;
	activeFile: { path: string; staged: boolean } | null;
	writes: GitWrites;
	/**
	 * Stages `rows`, or with `staged` unstages them; false when nothing was
	 * written, so the rows stay where they are. Resolves once the status the
	 * write invalidated has been read again (`useGitStage`).
	 */
	onStage: (rows: ChangedFile[], staged: boolean) => Promise<boolean>;
	/** Paths with a row in both groups, whose two rows are named apart. */
	partlyStaged: ReadonlySet<string>;
	onSelect: (path: string, staged: boolean) => void;
	onMore: (path: string, staged: boolean) => void;
}

/**
 * One of the list's groups: its header, with the button that moves every row
 * to the other group, and its rows, flat or as a tree of their own.
 *
 * A row moves out from under the button that moved it, and the keyboard focus
 * would go with it to `<body>`; the group hands it on to the button that now
 * stands where that one stood, or to its own header once it is empty.
 */
function ChangeGroup({
	kind,
	rows,
	view,
	worktree,
	activeFile,
	writes,
	onStage,
	onSelect,
	onMore,
	partlyStaged,
}: GroupProps & { kind: GroupKind; rows: ChangedFile[] }) {
	const headingId = useId();
	const sectionRef = useRef<HTMLElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const handoff = useRef<{ button: Element; index: number } | null>(null);
	const staged = kind === "staged";
	const busy = rows.some((f) => isPathWriting(writes, f.path));

	useLayoutEffect(() => {
		const pending = handoff.current;
		const section = sectionRef.current;
		if (!pending || !section || pending.button.isConnected) return;
		handoff.current = null;
		// Somewhere else since: the reader moved on, and the focus is theirs.
		const active = document.activeElement;
		if (active && active !== document.body) return;
		const buttons = section.querySelectorAll<HTMLElement>(
			"[data-stage-button]",
		);
		const next = buttons[Math.min(pending.index, buttons.length - 1)];
		(next ?? headingRef.current)?.focus();
	});

	// A press from the keyboard leaves the button focused; one from a pointer
	// may too, and handing that on is harmless — it draws no ring. Noted while
	// capturing, so it is in place before the press's own handler writes.
	const noteHandoff = (e: MouseEvent) => {
		const button =
			e.target instanceof Element && e.target.closest("[data-stage-button]");
		if (!button || button !== document.activeElement || !sectionRef.current)
			return;
		const buttons = [
			...sectionRef.current.querySelectorAll("[data-stage-button]"),
		];
		handoff.current = { button, index: buttons.indexOf(button) };
	};

	// A hand-off belongs to the press, and only while its button holds the
	// focus: once the focus has gone somewhere real, or the write left the row
	// where it was, a row leaving later must not pull the focus back here.
	const dropHandoff = (e: FocusEvent) => {
		if (e.relatedTarget && e.target === handoff.current?.button) {
			handoff.current = null;
		}
	};
	const move = useCallback(
		(target: ChangedFile[]) => {
			const pending = handoff.current;
			const drop = () => {
				if (handoff.current === pending) handoff.current = null;
			};
			onStage(target, staged).then((written) => {
				if (!written) {
					drop();
					return;
				}
				// The write answers after the status it invalidated was read
				// again, and the list renders that status from the query's own
				// notification, already scheduled: a task later, a row the write
				// moved has gone. One still there was changed again meanwhile.
				setTimeout(() => {
					if (pending?.button.isConnected) drop();
				});
			});
		},
		[onStage, staged],
	);

	// Stable, for the memoized rows.
	const stageRow = useCallback((file: ChangedFile) => move([file]), [move]);
	const selectRow = useCallback(
		(file: ChangedFile) => onSelect(file.path, staged),
		[onSelect, staged],
	);
	const moreRow = useCallback(
		(file: ChangedFile) => onMore(file.path, staged),
		[onMore, staged],
	);
	const rowProps: RowProps = {
		kind,
		activeFile,
		writes,
		partlyStaged,
		onStage: stageRow,
		onStageFolder: move,
		onSelect: selectRow,
		onMore: moreRow,
	};

	const count = `${rows.length} ${staged ? "staged" : "unstaged"} ${rows.length === 1 ? "file" : "files"}`;

	return (
		<section
			ref={sectionRef}
			aria-labelledby={headingId}
			onClickCapture={noteHandoff}
			onBlur={dropHandoff}
			className="flex flex-col gap-1"
		>
			<div className="flex min-h-[44px] items-center gap-2 pr-1 pl-2">
				{/* Focusable only from code: it takes the focus of the last row
				    to leave the group. */}
				<h3
					id={headingId}
					ref={headingRef}
					tabIndex={-1}
					className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md text-sm font-normal text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				>
					<span>{GROUP_NAME[kind]}</span>{" "}
					<span className="text-th-text-muted tabular-nums">{rows.length}</span>
				</h3>
				{kind !== "conflicts" && rows.length > 0 && (
					<button
						type="button"
						data-stage-button
						aria-label={`${staged ? "Unstage" : "Stage"} all ${count}`}
						aria-disabled={busy || undefined}
						aria-busy={busy || undefined}
						onClick={busy ? undefined : () => move(rows)}
						className={`flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg bg-th-bg-tertiary px-3 text-sm text-th-text-primary transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11 ${
							busy ? "cursor-not-allowed opacity-50" : "hover:opacity-90"
						}`}
					>
						{busy && (
							<Spinner variant="current" size="h-3.5 w-3.5" srText={null} />
						)}
						{staged ? "Unstage all" : "Stage all"}
					</button>
				)}
			</div>
			{kind !== "conflicts" && rows.length === 0 ? (
				<p className="px-2 pb-2 text-sm text-th-text-muted">
					{GROUP_EMPTY[kind]}
				</p>
			) : view === "flat" ? (
				rows.map((file) => (
					<FileRow key={file.path} file={file} depth={0} {...rowProps} />
				))
			) : (
				<FolderContents
					folder={buildChangeTree(rows)}
					depth={0}
					worktree={worktree}
					{...rowProps}
				/>
			)}
		</section>
	);
}

interface RowProps {
	kind: GroupKind;
	partlyStaged: ReadonlySet<string>;
	activeFile: { path: string; staged: boolean } | null;
	writes: GitWrites;
	onStage: (file: ChangedFile) => void;
	onStageFolder: (files: ChangedFile[]) => void;
	onSelect: (file: ChangedFile) => void;
	onMore: (file: ChangedFile) => void;
}

function FileRow({
	file,
	depth,
	kind,
	activeFile,
	writes,
	partlyStaged,
	onStage,
	onSelect,
	onMore,
}: RowProps & { file: ChangedFile; depth: number }) {
	const staged = kind === "staged";
	return (
		<ChangedFileRow
			file={file}
			depth={depth}
			staged={staged}
			namesSide={partlyStaged.has(file.path)}
			// A partly staged file has two rows; only the side under review is lit.
			// A conflict has no side, and is reviewed as unstaged.
			isActive={
				activeFile?.path === file.path &&
				(kind === "conflicts" || activeFile.staged === staged)
			}
			busy={isPathWriting(writes, file.path)}
			onStage={onStage}
			onSelect={onSelect}
			onMore={onMore}
		/>
	);
}

function FolderContents({
	folder,
	depth,
	worktree,
	...rowProps
}: RowProps & { folder: ChangeFolder; depth: number; worktree: string }) {
	return (
		<>
			{folder.folders.map((child) => (
				<FolderRow
					key={child.path}
					folder={child}
					depth={depth}
					worktree={worktree}
					{...rowProps}
				/>
			))}
			{folder.files.map((file) => (
				<FileRow key={file.path} file={file} depth={depth} {...rowProps} />
			))}
		</>
	);
}

/**
 * A folder of a group's tree: its button moves every file under it, at any
 * depth, collapsed or not, as one batch over paths — never a `git add <dir>`,
 * which would pick up files the list does not show.
 */
function FolderRow({
	folder,
	depth,
	worktree,
	...rowProps
}: RowProps & { folder: ChangeFolder; depth: number; worktree: string }) {
	const key = `${rowProps.kind}:${folder.path}`;
	const collapsed = useCollapsedFolders(worktree).includes(key);
	const files = filesUnder(folder);
	const Chevron = collapsed ? ChevronRight : ChevronDown;
	const staged = rowProps.kind === "staged";

	return (
		<>
			<div className="flex min-h-[44px] items-center rounded-lg transition-colors hover:bg-th-bg-tertiary">
				{rowProps.kind === "conflicts" ? (
					<StageGutter />
				) : (
					<StageButton
						action={staged ? "unstage" : "stage"}
						label={`${staged ? "Unstage" : "Stage"} folder ${folder.path}, ${files.length} ${files.length === 1 ? "file" : "files"}`}
						busy={files.some((f) => isPathWriting(rowProps.writes, f.path))}
						onPress={() => rowProps.onStageFolder(files)}
					/>
				)}
				<button
					type="button"
					aria-expanded={!collapsed}
					onClick={() => gitChangesViewActions.toggleFolder(worktree, key)}
					style={{ paddingLeft: depth * TREE_INDENT }}
					className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pr-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
				>
					<Chevron
						className="h-4 w-4 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
					<span className="min-w-0 flex-1 truncate text-sm text-th-text-primary">
						{folder.name}
					</span>
					<LineCounts lines={sumLines(files)} className="shrink-0" />
				</button>
			</div>
			{!collapsed && (
				<FolderContents
					folder={folder}
					depth={depth + 1}
					worktree={worktree}
					{...rowProps}
				/>
			)}
		</>
	);
}

/**
 * The wording of a discard confirmation, which differs by what is actually lost:
 * a tracked file gives up edits, an untracked one stops existing.
 */
function DiscardConfirm({
	files,
	keepsStaged,
	onConfirm,
	onCancel,
}: {
	files: FileStatus[];
	keepsStaged: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { title, message, confirmLabel } = describeDiscard(files, keepsStaged);

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

export default ChangesSection;
