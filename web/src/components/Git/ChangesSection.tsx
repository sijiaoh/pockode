import { ConfirmDialog } from "@pockode/shared";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitWriteRunner } from "../../hooks/useGitWrites";
import { useRouteState } from "../../hooks/useRouteState";
import {
	adjacentChange,
	aggregateCheckState,
	buildChangeTree,
	type ChangedFile,
	type ChangeFolder,
	checkboxWrite,
	collectChanges,
	describeStageable,
	filesUnder,
	orderChanges,
	reviewSideOf,
	sumLines,
	withoutConflicts,
} from "../../lib/gitChanges";
import {
	gitChangesViewActions,
	useCollapsedFolders,
	useGitChangesViewStore,
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
import StageCheckbox, { StageGutter } from "./StageCheckbox";

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
}

/**
 * The working tree's changes as one list, a row per path with its checkbox,
 * under a header that stages and totals them all, and over the commit bar that
 * discards what is left unchecked — the Git workspace's Changes segment
 * (docs/git-changes-ui.md).
 */
function ChangesSection({ onSelectFile, onCloseFile, activeFile }: Props) {
	const navigate = useNavigate();
	const { worktree: routeWorktree, sessionId } = useRouteState();
	const { data: status, isLoading, error } = useGitStatus();
	const { toggle, discard, writes } = useGitWriteRunner();
	// The files a confirmation is currently open for; null when none is.
	const [pendingDiscard, setPendingDiscard] = useState<FileStatus[] | null>(
		null,
	);
	// By path, so the sheet follows the file through refreshes — and goes
	// when the file stops having changes.
	const [menuPath, setMenuPath] = useState<string | null>(null);
	// The worktree the runner sends to, read in the same render, so a failure
	// is filed under the worktree whose paths it names.
	const worktree = useWorktreeStore((s) => s.current);
	const actionError = useWriteFailure(worktree);
	const view = useGitChangesViewStore((s) => s.view);

	const files = useMemo(
		() => (status ? orderChanges(collectChanges(status), view) : []),
		[status, view],
	);
	// A discard answers after the press; what follows a file then is read from
	// the list as it is then.
	const latest = useRef({ files, view });
	useLayoutEffect(() => {
		latest.current = { files, view };
	});

	const togglePaths = useCallback(
		async (paths: string[], staged: boolean) => {
			if (paths.length === 0) return;
			try {
				await toggle(paths, staged);
				gitWriteActions.succeed(worktree, paths);
			} catch (e) {
				if (e instanceof WorktreeChangedError) return;
				gitWriteActions.fail(worktree, {
					...describeGitFailure(e, () => stageFailureSummary(staged)),
					paths,
				});
			}
		},
		[toggle, worktree],
	);

	const toggleFiles = useCallback(
		(target: ChangedFile[]) => {
			const { paths, staged } = checkboxWrite(target);
			togglePaths(paths, staged);
		},
		[togglePaths],
	);

	const toggleFile = useCallback(
		(file: ChangedFile) => toggleFiles([file]),
		[toggleFiles],
	);

	const selectFile = useCallback(
		(file: ChangedFile) => onSelectFile(file.path, reviewSideOf(file, false)),
		[onSelectFile],
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

	const menuFile = menuPath
		? (files.find((f) => f.path === menuPath) ?? null)
		: null;
	// Forgotten once the file is gone, so that the sheet does not come back by
	// itself if the same path changes again later.
	useEffect(() => {
		if (menuPath && !menuFile) setMenuPath(null);
	}, [menuPath, menuFile]);
	const closeMenu = useCallback(() => setMenuPath(null), []);
	const openMenu = useCallback(
		(file: ChangedFile) => setMenuPath(file.path),
		[],
	);

	const openFile = useCallback(
		(path: string) => {
			setMenuPath(null);
			navigate(
				overlayToNavigation({ type: "file", path }, routeWorktree, sessionId),
			);
		},
		[navigate, routeWorktree, sessionId],
	);

	const openHistory = useCallback(
		(path: string) => {
			setMenuPath(null);
			navigate(
				overlayToNavigation(fileHistoryOverlay(path), routeWorktree, sessionId),
			);
		},
		[navigate, routeWorktree, sessionId],
	);

	const discardFile = useCallback((file: ChangedFile) => {
		setMenuPath(null);
		if (file.unstaged) setPendingDiscard([file.unstaged]);
	}, []);

	// Unchecked is unstaged: a file checked in part keeps what is staged, and a
	// conflict, which has no unstaged side, is passed over.
	const unchecked = useMemo(
		() => files.flatMap((f) => (f.unstaged ? [f.unstaged] : [])),
		[files],
	);
	const busy = files.some((f) => isPathWriting(writes, f.path));

	const rowProps = {
		activePath: activeFile?.path ?? null,
		writes,
		onToggle: toggleFile,
		onToggleFolder: toggleFiles,
		onSelect: selectFile,
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
			<div className="@container min-h-0 flex-1 overflow-y-auto">
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
							busy={busy}
							view={view}
							onToggleAll={() => toggleFiles(files)}
							onChangeView={gitChangesViewActions.setView}
						/>
						<div className="flex flex-col gap-1 px-2 py-2">
							{view === "flat" ? (
								files.map((file) => (
									<FileRow
										key={file.path}
										file={file}
										depth={0}
										{...rowProps}
									/>
								))
							) : (
								<FolderContents
									folder={buildChangeTree(files)}
									depth={0}
									worktree={worktree}
									{...rowProps}
								/>
							)}
						</div>
					</>
				)}
			</div>

			<CommitBar
				discardUnchecked={
					unchecked.length > 0
						? { onDiscard: () => setPendingDiscard(unchecked), busy }
						: null
				}
			/>

			{menuFile && (
				<ChangedFileMenu
					file={menuFile}
					onClose={closeMenu}
					onOpenFile={openFile}
					onOpenHistory={openHistory}
					onDiscard={discardFile}
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

interface RowProps {
	activePath: string | null;
	writes: GitWrites;
	onToggle: (file: ChangedFile) => void;
	onToggleFolder: (files: ChangedFile[]) => void;
	onSelect: (file: ChangedFile) => void;
	onMore: (file: ChangedFile) => void;
}

function FileRow({
	file,
	depth,
	activePath,
	writes,
	onToggle,
	onSelect,
	onMore,
}: RowProps & { file: ChangedFile; depth: number }) {
	return (
		<ChangedFileRow
			file={file}
			depth={depth}
			isActive={activePath === file.path}
			busy={isPathWriting(writes, file.path)}
			onToggle={onToggle}
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
 * A folder of the tree: its checkbox stands for every file under it, at any
 * depth, collapsed or not, and writes them as one batch over paths — never a
 * `git add <dir>`, which would pick up files the list does not show.
 */
function FolderRow({
	folder,
	depth,
	worktree,
	...rowProps
}: RowProps & { folder: ChangeFolder; depth: number; worktree: string }) {
	const collapsed = useCollapsedFolders(worktree).includes(folder.path);
	const files = filesUnder(folder);
	const Chevron = collapsed ? ChevronRight : ChevronDown;

	return (
		<>
			<div className="flex min-h-[44px] items-center rounded-lg transition-colors hover:bg-th-bg-tertiary">
				{withoutConflicts(files).length > 0 ? (
					<StageCheckbox
						state={aggregateCheckState(files)}
						label={`Stage folder ${folder.path}, ${describeStageable(files)}`}
						busy={files.some((f) => isPathWriting(rowProps.writes, f.path))}
						onToggle={() => rowProps.onToggleFolder(files)}
					/>
				) : (
					<StageGutter />
				)}
				<button
					type="button"
					aria-expanded={!collapsed}
					onClick={() =>
						gitChangesViewActions.toggleFolder(worktree, folder.path)
					}
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
