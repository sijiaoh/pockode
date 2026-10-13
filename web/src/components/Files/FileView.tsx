import { ConfirmDialog } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Code, Loader2, Pencil, PencilLine, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFileDownload } from "../../hooks/useFileDownload";
import { useFSWatch } from "../../hooks/useFSWatch";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { useTakenNames } from "../../hooks/useTakenNames";
import { applyEntryGone } from "../../lib/fileCache";
import { overlayToNavigation } from "../../lib/navigation";
import { isAlreadyExistsError } from "../../lib/rpc/file";
import { useWSStore } from "../../lib/wsStore";
import { isFileContent } from "../../types/contents";
import {
	canEditFileView,
	getEditLabel,
	getFileViewState,
} from "../../utils/fileView";
import { parentDir, splitPath } from "../../utils/path";
import { FilePageHeader } from "../Layout/PageHeader";
import {
	BottomActionBar,
	ContentView,
	getActionIconButtonClass,
	ToggleIconButton,
} from "../ui";
import EntryNameDialog from "./EntryNameDialog";
import FileBody from "./FileBody";
import { DownloadButton } from "./FileDownloadControls";

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
	// A page's source rather than the page. Kept across files, as the commit
	// view's toggle is: someone reading several pages' source in a row should
	// not have to press it again for each.
	const [showSource, setShowSource] = useState(false);
	// One banner for every file-level action: two stacked error bars would read
	// as two separate failures.
	const [actionError, setActionError] = useState<string | null>(null);
	// Only fetched while the sheet is open: the folder around a file opened from
	// search or a chat link has never been listed here.
	const takenNames = useTakenNames(showRename ? parentDir(path) : null);

	const file = data && isFileContent(data) ? data : null;
	const state = useMemo(
		() => (file ? getFileViewState(file, { kind: "file", path }) : null),
		[file, path],
	);
	const download = useFileDownload({
		path,
		worktree,
		onError: setActionError,
	});

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

	// The view is reused across paths (`ChatPanel` renders it with no key), so
	// everything the action bar holds has to be dropped when the file changes:
	// otherwise "File not found" from a.zip sits above b.txt. The download
	// drops its own (`useFileDownload`).
	// biome-ignore lint/correctness/useExhaustiveDependencies: the setters are stable; path and worktree are the trigger, not values the body reads
	useEffect(() => {
		setActionError(null);
		setShowDeleteConfirm(false);
		setShowRename(false);
		setRenameError(null);
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
	const isPage = state?.kind === "page";

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<FilePageHeader path={path} back={{ to: "chat", onClick: onBack }} />
			<ContentView
				isLoading={isLoading}
				error={error instanceof Error ? error : null}
				fill={isPage && !showSource}
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
						plain={isPage && showSource}
						downloadAction={{
							label: download.label,
							onClick: download.toggle,
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
						<DownloadButton download={download} disabled={isDeleting} />
						{isPage && (
							<ToggleIconButton
								icon={Code}
								pressed={showSource}
								onClick={() => setShowSource((v) => !v)}
								label={showSource ? "Show page" : "Show source"}
							/>
						)}
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
		</div>
	);
}

export default FileView;
