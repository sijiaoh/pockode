import { ConfirmDialog } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Download, Loader2, Pencil, PencilLine, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { useTakenNames } from "../../hooks/useTakenNames";
import { isAbortError } from "../../lib/api";
import { applyEntryGone } from "../../lib/fileCache";
import {
	downloadFile,
	LARGE_DOWNLOAD_WARNING_SIZE,
} from "../../lib/fileDownload";
import { overlayToNavigation } from "../../lib/navigation";
import { isAlreadyExistsError } from "../../lib/rpc/file";
import { useWSStore } from "../../lib/wsStore";
import { isFileContent } from "../../types/contents";
import { formatBytes } from "../../utils/bytes";
import {
	canEditFileView,
	getEditLabel,
	getFileViewState,
} from "../../utils/fileView";
import { parentDir, splitPath } from "../../utils/path";
import { BottomActionBar, ContentView, getActionIconButtonClass } from "../ui";
import EntryNameDialog from "./EntryNameDialog";
import FileBody from "./FileBody";

interface Props {
	path: string;
	onBack: () => void;
}

function FileView({ path, onBack }: Props) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const worktree = useCurrentWorktree();
	const { sessionId } = useRouteState();
	const { data, isLoading, error } = useContents(path);
	const deleteFile = useWSStore((s) => s.actions.deleteFile);
	const renameFile = useWSStore((s) => s.actions.renameFile);

	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	// The only way to rename a file reached from search or from a chat link:
	// neither has a tree row, and so neither has the row's `…` menu.
	const [showRename, setShowRename] = useState(false);
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameError, setRenameError] = useState<string | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);
	const [showSizeConfirm, setShowSizeConfirm] = useState(false);
	const [isDownloading, setIsDownloading] = useState(false);
	// One banner for every file-level action: two stacked error bars would read
	// as two separate failures.
	const [actionError, setActionError] = useState<string | null>(null);
	const downloadAbort = useRef<AbortController | null>(null);
	// Only fetched while the sheet is open: the folder around a file opened from
	// search or a chat link has never been listed here.
	const takenNames = useTakenNames(showRename ? parentDir(path) : null);

	const file = data && isFileContent(data) ? data : null;
	const state = useMemo(() => (file ? getFileViewState(file) : null), [file]);

	const navigateToEdit = useCallback(() => {
		navigate(
			overlayToNavigation(
				{ type: "file", path, edit: true },
				worktree,
				sessionId,
			),
		);
	}, [navigate, path, worktree, sessionId]);

	const handleRename = useCallback(
		async (name: string) => {
			const dir = parentDir(path);
			const newPath = dir ? `${dir}/${name}` : name;

			setIsRenaming(true);
			setRenameError(null);
			try {
				await renameFile(path, name);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// A taken name is answerable by typing another one, so the sheet
				// stays up holding it; anything else is about the request and leaves
				// with the sheet for the banner.
				if (isAlreadyExistsError(err)) {
					setRenameError(message);
				} else {
					setShowRename(false);
					setActionError(message);
				}
				return;
			} finally {
				setIsRenaming(false);
			}

			setShowRename(false);
			applyEntryGone(queryClient, path);
			// Followed to the new path rather than closed: the file is still there,
			// and the user is still reading it. Replaced rather than pushed —
			// nobody navigated, and the entry left behind would only send Back to
			// a path that no longer resolves.
			navigate(
				overlayToNavigation(
					{ type: "file", path: newPath },
					worktree,
					sessionId,
					{
						replace: true,
					},
				),
			);
		},
		[renameFile, path, queryClient, navigate, worktree, sessionId],
	);

	const handleDeleteClick = useCallback(() => {
		setActionError(null);
		setShowDeleteConfirm(true);
	}, []);

	const handleDeleteConfirm = useCallback(async () => {
		setShowDeleteConfirm(false);
		setIsDeleting(true);
		setActionError(null);
		try {
			await deleteFile(path);
			// The same cache work the tree's delete does, through the same
			// function: this used to invalidate the root listing instead of the
			// one the file was actually in, which left the deleted row on screen
			// in every folder but the root.
			applyEntryGone(queryClient, path);
			onBack();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : "Failed to delete");
		} finally {
			setIsDeleting(false);
		}
	}, [deleteFile, path, queryClient, onBack]);

	const startDownload = useCallback(async () => {
		const controller = new AbortController();
		downloadAbort.current = controller;
		setIsDownloading(true);
		setActionError(null);
		try {
			await downloadFile({ path, worktree, signal: controller.signal });
		} catch (err) {
			// A cancellation is the user's own doing and needs no report.
			if (!isAbortError(err)) {
				const message = err instanceof Error ? err.message : String(err);
				setActionError(`Download failed: ${message}`);
			}
		} finally {
			// Only if it is still this download's: a controller belonging to a
			// newer one must stay reachable, or it could never be cancelled.
			if (downloadAbort.current === controller) downloadAbort.current = null;
			setIsDownloading(false);
		}
	}, [path, worktree]);

	const handleDownloadClick = useCallback(() => {
		if (isDownloading) {
			downloadAbort.current?.abort();
			return;
		}
		// The whole file is assembled in memory before the browser takes it, so a
		// very large one is worth a word before the tab is on the hook for it.
		if (file && file.size > LARGE_DOWNLOAD_WARNING_SIZE) {
			setActionError(null);
			setShowSizeConfirm(true);
			return;
		}
		startDownload();
	}, [isDownloading, file, startDownload]);

	// The view is reused across paths (`ChatPanel` renders it with no key), so
	// everything the action bar holds has to be dropped when the file changes:
	// otherwise "File not found" from a.zip sits above b.txt, a confirmation
	// quoting one file's size confirms another's, and the spinner keeps turning
	// for a transfer that belonged to the previous file.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the setters are stable; path and worktree are the trigger, not values the body reads
	useEffect(() => {
		setActionError(null);
		setShowSizeConfirm(false);
		setShowDeleteConfirm(false);
		setShowRename(false);
		setRenameError(null);
		setIsDownloading(false);
		// Nor should a transfer keep running for a page nobody is looking at, or
		// save the file the user has just navigated away from.
		return () => downloadAbort.current?.abort();
	}, [path, worktree]);

	useFSWatch({
		path,
		onChanged: useCallback(() => {
			queryClient.invalidateQueries({ queryKey: contentsQueryKey(path) });
		}, [queryClient, path]),
	});

	// Deleting stays available for everything the viewer cannot render; only
	// editing depends on there being editable text. While the file is loading or
	// failed to load there is nothing to act on at all.
	const canEdit = state !== null && canEditFileView(state);
	const { fileName } = splitPath(path);
	const downloadLabel = isDownloading ? "Cancel download" : "Download";

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={path}
				isLoading={isLoading}
				error={error instanceof Error ? error : null}
				onBack={onBack}
			>
				{actionError && (
					<div className="border-b border-th-error/20 bg-th-error/10 px-4 py-2 text-sm text-th-error">
						{actionError}
					</div>
				)}
				{state && (
					<FileBody
						state={state}
						path={path}
						downloadAction={{
							label: downloadLabel,
							onClick: handleDownloadClick,
							// Matches the bottom bar's button: two entry points for one
							// action must not disagree about when it is available.
							disabled: isDeleting,
						}}
					/>
				)}
			</ContentView>
			{state && (
				<BottomActionBar>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={navigateToEdit}
							disabled={isDeleting || !canEdit}
							className={getActionIconButtonClass(!isDeleting && canEdit)}
							aria-label={getEditLabel(state)}
							title={getEditLabel(state)}
						>
							<Pencil className="h-4 w-4" aria-hidden="true" />
						</button>
						{/* A different pencil from Edit's on purpose: the two sit side by
						    side, and one changes the contents while the other changes the
						    name. */}
						<button
							type="button"
							onClick={() => {
								setActionError(null);
								setRenameError(null);
								setShowRename(true);
							}}
							disabled={isDeleting || isRenaming}
							className={getActionIconButtonClass(!isDeleting && !isRenaming)}
							aria-label="Rename"
							title="Rename"
						>
							<PencilLine className="h-4 w-4" aria-hidden="true" />
						</button>
						<button
							type="button"
							onClick={handleDownloadClick}
							disabled={isDeleting}
							className={getActionIconButtonClass(!isDeleting)}
							aria-label={downloadLabel}
							title={downloadLabel}
						>
							{isDownloading ? (
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
							) : (
								<Download className="h-4 w-4" aria-hidden="true" />
							)}
						</button>
						{/* Last on purpose: the destructive action is the one a thumb
						    should not reach by accident on a small screen. */}
						<button
							type="button"
							onClick={handleDeleteClick}
							disabled={isDeleting}
							className={getActionIconButtonClass(!isDeleting)}
							aria-label="Delete"
						>
							{isDeleting ? (
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
							) : (
								<Trash2 className="h-4 w-4" aria-hidden="true" />
							)}
						</button>
					</div>
				</BottomActionBar>
			)}
			{showRename && (
				<EntryNameDialog
					mode="rename"
					type="file"
					dir={parentDir(path)}
					currentName={fileName}
					takenNames={takenNames}
					submitting={isRenaming}
					serverError={renameError}
					onCancel={() => setShowRename(false)}
					onSubmit={handleRename}
				/>
			)}
			{showDeleteConfirm && (
				<ConfirmDialog
					title="Delete file?"
					message={`This will delete "${fileName}". This action cannot be undone.`}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDeleteConfirm}
					onCancel={() => setShowDeleteConfirm(false)}
				/>
			)}
			{showSizeConfirm && file && (
				<ConfirmDialog
					title="Download this file?"
					message={`This file is ${formatBytes(file.size)}. Your browser holds the whole file until the download finishes — you get nothing if it is interrupted.`}
					confirmLabel="Download"
					onConfirm={() => {
						setShowSizeConfirm(false);
						startDownload();
					}}
					onCancel={() => setShowSizeConfirm(false)}
				/>
			)}
		</div>
	);
}

export default FileView;
