import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Code, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { overlayToNavigation } from "../../lib/navigation";
import { isMarkdownFile } from "../../lib/shikiUtils";
import { isFileContent } from "../../types/contents";
import {
	actionIconButtonClass,
	BottomActionBar,
	ContentView,
	FileContentDisplay,
	navButtonActiveClass,
	navButtonClass,
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
	const [showRaw, setShowRaw] = useState(false);
	const isMarkdown = isMarkdownFile(path);

	const isBinary = data && isFileContent(data) && data.encoding !== "text";

	const handleEdit = useCallback(() => {
		navigate(
			overlayToNavigation(
				{ type: "file", path, edit: true },
				worktree,
				sessionId,
			),
		);
	}, [navigate, path, worktree, sessionId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset showRaw when path changes
	useEffect(() => {
		setShowRaw(false);
	}, [path]);

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
				<FileContentDisplay
					content={data.content}
					filePath={path}
					showRaw={showRaw}
				/>
			</div>
		);
	}, [data, path, showRaw]);

	const headerActions = isMarkdown ? (
		<button
			type="button"
			onClick={() => setShowRaw(!showRaw)}
			className={showRaw ? navButtonActiveClass : navButtonClass}
			aria-label={showRaw ? "Show rendered" : "Show raw"}
			aria-pressed={showRaw}
		>
			<Code className="h-5 w-5" aria-hidden="true" />
		</button>
	) : null;

	const showActionBar = !isBinary;

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={path}
				isLoading={isLoading}
				error={error instanceof Error ? error : null}
				onBack={onBack}
				headerActions={headerActions}
			>
				{content}
			</ContentView>
			{showActionBar && (
				<BottomActionBar>
					<div className="flex items-center">
						<button
							type="button"
							onClick={handleEdit}
							className={actionIconButtonClass}
							aria-label="Edit"
						>
							<Pencil className="h-4 w-4" aria-hidden="true" />
						</button>
					</div>
				</BottomActionBar>
			)}
		</div>
	);
}

export default FileView;
