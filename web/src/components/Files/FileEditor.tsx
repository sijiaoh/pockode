import { useIsExpanded } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Eye, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import Editor from "react-simple-code-editor";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
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
import { EDITOR_HIGHLIGHT_LIMIT } from "../../utils/fileView";
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
	const isExpanded = useIsExpanded();

	const [content, setContent] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [isInitialized, setIsInitialized] = useState(false);

	const file = data && isFileContent(data) ? data : null;
	const isBinary = file !== null && file.encoding !== "text";

	// Large files stay editable and only lose their colours, which
	// `useEditorHighlight` already falls back to when it has no language.
	//
	// Measured against the buffer as well as the file it came from: the server's
	// size settles what was loaded, but pasting into a small file grows what has
	// to be re-highlighted on every keystroke. `length` counts UTF-16 units and
	// so undercounts multi-byte text, but it is O(1) — and taking the larger of
	// the two keeps the byte-accurate figure as the floor.
	const isLargeText =
		Math.max(file?.size ?? 0, content.length) > EDITOR_HIGHLIGHT_LIMIT;
	const language = isLargeText ? undefined : getLanguageFromPath(path);
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

	// Initialize content when data loads
	// biome-ignore lint/correctness/useExhaustiveDependencies: path triggers re-init
	useEffect(() => {
		if (data && isFileContent(data) && data.encoding === "text") {
			setContent(data.content);
			setIsInitialized(true);
			setSaveError(null);
		}
	}, [data, path]);

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

	const fontSize = isExpanded ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE;
	const canSave = isInitialized && !isSaving;

	const displayError = error instanceof Error ? error : null;

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={path}
				isLoading={isLoading}
				error={displayError}
				onBack={onBack}
			>
				{/* `min-h-full` fills the scroll area even for a short file and `grow`
				    hands the spare height to the editor, whose textarea covers its whole
				    root. That is what turns the blank space under a one-line file into
				    part of the textarea, so a tap there enters editing instead of hitting
				    nothing. `grow` and not `flex-1`: a `flex-basis: 0` would size this
				    column from the viewport rather than from the file, leaving a long
				    file clipped by the root's `overflow: hidden` with nothing to scroll
				    — see `.editor-root` in index.css. */}
				<div className="flex min-h-full flex-col">
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
						className="editor-root grow"
						style={{
							fontSize,
							lineHeight: 1.5,
						}}
						textareaClassName="editor-textarea"
					/>
				</div>
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
						className={`flex items-center gap-1.5 rounded border border-th-border bg-th-bg-tertiary h-9 px-3 text-xs transition-all pointer-coarse:h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
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
