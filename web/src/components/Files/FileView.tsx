import { ConfirmDialog } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { overlayToNavigation } from "../../lib/navigation";
import { useWSStore } from "../../lib/wsStore";
import { isFileContent } from "../../types/contents";
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
	const [deleteError, setDeleteError] = useState<string | null>(null);

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
		setDeleteError(null);
		setShowDeleteConfirm(true);
	}, []);

	const handleDeleteConfirm = useCallback(async () => {
		setShowDeleteConfirm(false);
		setIsDeleting(true);
		setDeleteError(null);
		try {
			await deleteFile(path);
			queryClient.invalidateQueries({ queryKey: contentsQueryKey("") });
			onBack();
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : "Failed to delete");
		} finally {
			setIsDeleting(false);
		}
	}, [deleteFile, path, queryClient, onBack]);

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

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={path}
				isLoading={isLoading}
				error={error instanceof Error ? error : null}
				onBack={onBack}
			>
				{deleteError && (
					<div className="border-b border-th-error/20 bg-th-error/10 px-4 py-2 text-sm text-th-error">
						{deleteError}
					</div>
				)}
				{state && <FileBody state={state} path={path} />}
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
		</div>
	);
}

export default FileView;
