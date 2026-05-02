import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Eye, FilePlus, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "react-simple-code-editor";
import {
	contentsQueryKey,
	isNotFoundError,
	useContents,
} from "../../hooks/useContents";
import { useIsDesktop } from "../../hooks/useIsDesktop";
import { useCurrentWorktree, useRouteState } from "../../hooks/useRouteState";
import { overlayToNavigation } from "../../lib/navigation";
import {
	CODE_FONT_SIZE_DESKTOP,
	CODE_FONT_SIZE_MOBILE,
	getLanguageFromPath,
	useEditorHighlight,
} from "../../lib/shikiUtils";
import { useWSStore } from "../../lib/wsStore";
import { isFileContent } from "../../types/contents";
import { BottomActionBar, ContentView, getActionIconButtonClass } from "../ui";

interface Props {
	path: string;
	onBack: () => void;
}

function FileEditor({ path, onBack }: Props) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const worktree = useCurrentWorktree();
	const { sessionId } = useRouteState();
	const { data, isLoading, error } = useContents(path);
	const writeFile = useWSStore((s) => s.actions.writeFile);
	const isDesktop = useIsDesktop();

	const [content, setContent] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [isInitialized, setIsInitialized] = useState(false);

	const isNewFile = useMemo(() => isNotFoundError(error), [error]);
	const isBinary = data && isFileContent(data) && data.encoding !== "text";
	const language = getLanguageFromPath(path);
	const highlight = useEditorHighlight(language);

	const navigateToView = useCallback(() => {
		navigate(
			overlayToNavigation(
				{ type: "file", path, edit: false },
				worktree,
				sessionId,
			),
		);
	}, [navigate, path, worktree, sessionId]);

	// Initialize content when data loads or when creating new file
	// biome-ignore lint/correctness/useExhaustiveDependencies: path triggers re-init for new file
	useEffect(() => {
		if (isNewFile) {
			setContent("");
			setIsInitialized(true);
			setSaveError(null);
		} else if (data && isFileContent(data) && data.encoding === "text") {
			setContent(data.content);
			setIsInitialized(true);
			setSaveError(null);
		}
	}, [data, path, isNewFile]);

	// Redirect to view if binary file accessed via direct URL
	useEffect(() => {
		if (isBinary) {
			navigateToView();
		}
	}, [isBinary, navigateToView]);

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		setSaveError(null);
		try {
			await writeFile(path, content);
			queryClient.invalidateQueries({ queryKey: contentsQueryKey(path) });
			navigateToView();
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setIsSaving(false);
		}
	}, [path, content, writeFile, queryClient, navigateToView]);

	const fontSize = isDesktop ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE;
	const canSave = isInitialized && !isSaving;

	// Only show non-"not found" errors
	const displayError = error instanceof Error && !isNewFile ? error : null;

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={path}
				isLoading={isLoading}
				error={displayError}
				onBack={onBack}
			>
				{isNewFile && (
					<div className="flex items-center gap-1.5 border-b border-th-accent/20 bg-th-accent/10 px-4 py-2 text-sm text-th-accent">
						<FilePlus className="h-4 w-4" aria-hidden="true" />
						<span>New file</span>
					</div>
				)}
				{saveError && (
					<div className="border-b border-th-error/20 bg-th-error/10 px-4 py-2 text-sm text-th-error">
						{saveError}
					</div>
				)}
				<Editor
					value={content}
					onValueChange={setContent}
					highlight={highlight}
					padding={16}
					disabled={isSaving}
					className="editor-root"
					style={{
						fontSize,
						lineHeight: 1.5,
					}}
					textareaClassName="editor-textarea"
				/>
			</ContentView>
			<BottomActionBar>
				<div className="flex items-center justify-between">
					<button
						type="button"
						onClick={navigateToView}
						disabled={isSaving}
						className={getActionIconButtonClass(!isSaving)}
						aria-label="View"
					>
						<Eye className="h-4 w-4" aria-hidden="true" />
					</button>
					<button
						type="button"
						onClick={handleSave}
						disabled={!canSave}
						className={`flex items-center gap-1.5 rounded border border-th-border bg-th-bg-tertiary h-8 px-3 text-xs transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
							canSave
								? "text-th-success hover:border-th-border-focus"
								: "opacity-50 cursor-not-allowed text-th-text-muted"
						}`}
						aria-label="Save"
					>
						{isSaving ? (
							<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						) : (
							<Check className="h-4 w-4" aria-hidden="true" />
						)}
						Save
					</button>
				</div>
			</BottomActionBar>
		</div>
	);
}

export default FileEditor;
