import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	contentsQueryKey,
	isNotFoundError,
	useContents,
} from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { overlayToNavigation } from "../../lib/navigation";
import { useWSStore } from "../../lib/wsStore";
import { isFileContent } from "../../types/contents";
import ConfirmDialog from "../common/ConfirmDialog";
import {
	BottomActionBar,
	ContentView,
	FileContentDisplay,
	getActionIconButtonClass,
} from "../ui";

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

	const isBinary = data && isFileContent(data) && data.encoding !== "text";

	const navigateToEdit = useCallback(() => {
		navigate(
			overlayToNavigation(
				{ type: "file", path, edit: true },
				worktree,
				sessionId,
			),
		);
	}, [navigate, path, worktree, sessionId]);

	// Redirect to edit mode if file doesn't exist
	const isNewFile = isNotFoundError(error);
	useEffect(() => {
		if (isNewFile) {
			navigateToEdit();
		}
	}, [isNewFile, navigateToEdit]);

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

	const content = useMemo(() => {
		if (!data || !isFileContent(data)) return null;

		const ext = path.split(".").pop()?.toLowerCase();

		if (data.encoding === "text" && ext === "svg") {
			return (
				<div className="flex items-center justify-center p-4">
					<img
						src={`data:image/svg+xml,${encodeURIComponent(data.content)}`}
						alt={path}
						className="max-w-full max-h-[70vh] object-contain"
					/>
				</div>
			);
		}

		if (data.encoding === "base64") {
			const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext ?? "");

			if (isImage) {
				const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
				return (
					<div className="flex items-center justify-center p-4">
						<img
							src={`data:${mimeType};base64,${data.content}`}
							alt={path}
							className="max-w-full max-h-[70vh] object-contain"
						/>
					</div>
				);
			}

			return (
				<div className="p-4 text-center text-th-text-muted">
					Binary file cannot be displayed
				</div>
			);
		}

		return (
			<div className="p-2">
				<FileContentDisplay content={data.content} filePath={path} />
			</div>
		);
	}, [data, path]);

	const showActionBar = !isBinary;
	const fileName = path.split("/").pop() ?? path;

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
				{content}
			</ContentView>
			{showActionBar && (
				<BottomActionBar>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={navigateToEdit}
							disabled={isDeleting}
							className={getActionIconButtonClass(!isDeleting)}
							aria-label="Edit"
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
