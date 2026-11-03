import { useIsExpanded } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import Editor from "react-simple-code-editor";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useGoToParent } from "../../hooks/useGoToParent";
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
import { FilePageHeader } from "../Layout/PageHeader";
import {
	ContentView,
	DetailActionBottomBar,
	type DetailActions,
	detailActionsPlacement,
	getActionIconButtonClass,
	PrimaryActionButton,
	ViewToolbar,
} from "../ui";

interface Props {
	path: string;
	onBack: () => void;
	/** The composer holds a soft keyboard (`DetailActionsPlacement`). */
	keyboardUp?: boolean;
}

function FileEditor({ path, onBack, keyboardUp = false }: Props) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const worktree = useCurrentWorktree();
	const { sessionId } = useRouteState();
	const { data, isLoading, error } = useContents(path);
	const writeFile = useWSStore((s) => s.actions.writeFile);
	const isExpanded = useIsExpanded();
	const actionsAt = detailActionsPlacement(isExpanded, keyboardUp);

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

	// Up to the view it was entered from, not a push of it: a pushed view left
	// the editor right behind it, for Back to reopen.
	const goToParent = useGoToParent();
	const navigateToView = useCallback(() => {
		goToParent({ worktree, overlay: { type: "file", path, edit: true } });
	}, [goToParent, path, worktree]);

	// Initialize content when data loads
	// biome-ignore lint/correctness/useExhaustiveDependencies: path triggers re-init
	useEffect(() => {
		if (data && isFileContent(data) && data.encoding === "text") {
			setContent(data.content);
			setIsInitialized(true);
			setSaveError(null);
		}
	}, [data, path]);

	// A binary file has no editor: its URL is corrected to the view, in place.
	useEffect(() => {
		if (isBinary) {
			navigate(
				overlayToNavigation({ type: "file", path }, worktree, sessionId, {
					replace: true,
				}),
			);
		}
	}, [isBinary, navigate, path, worktree, sessionId]);

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

	// View leaves without saving, so it takes the leading edge, farthest from
	// Save.
	const actions: DetailActions = {
		leading: (
			<button
				type="button"
				onClick={navigateToView}
				disabled={isSaving}
				className={getActionIconButtonClass(!isSaving)}
				aria-label="View"
				title="View"
			>
				<Eye className="h-4 w-4" aria-hidden="true" />
			</button>
		),
		primary: (
			<PrimaryActionButton
				label="Save"
				onClick={handleSave}
				disabled={!canSave}
				pendingLabel={isSaving ? "Saving…" : null}
			/>
		),
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<FilePageHeader
				path={path}
				status="Editing"
				back={{ to: "chat", onClick: onBack }}
			/>
			<ViewToolbar actions={actions} actionsAt={actionsAt} />
			<ContentView isLoading={isLoading} error={displayError}>
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
			<DetailActionBottomBar actions={actions} actionsAt={actionsAt} />
		</div>
	);
}

export default FileEditor;
