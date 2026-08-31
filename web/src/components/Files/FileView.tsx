import { ConfirmDialog } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Download, Loader2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { isAbortError } from "../../lib/api";
import {
	downloadFile,
	LARGE_DOWNLOAD_WARNING_SIZE,
} from "../../lib/fileDownload";
import { overlayToNavigation } from "../../lib/navigation";
import { useWSStore } from "../../lib/wsStore";
import { isFileContent } from "../../types/contents";
import { formatBytes } from "../../utils/bytes";
import {
	canEditFileView,
	getEditLabel,
	getFileViewState,
} from "../../utils/fileView";
import { splitPath } from "../../utils/path";
import { BottomActionBar, ContentView, getActionIconButtonClass } from "../ui";
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

	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [showSizeConfirm, setShowSizeConfirm] = useState(false);
	const [isDownloading, setIsDownloading] = useState(false);
	// One banner for every file-level action: two stacked error bars would read
	// as two separate failures.
	const [actionError, setActionError] = useState<string | null>(null);
	const downloadAbort = useRef<AbortController | null>(null);

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
			queryClient.invalidateQueries({ queryKey: contentsQueryKey("") });
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
