import { useNavigate } from "@tanstack/react-router";
import { Type } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCommitFile } from "../../hooks/useCommitFile";
import { useFileDownload } from "../../hooks/useFileDownload";
import { useGitCommit } from "../../hooks/useGitCommit";
import { useRouteState } from "../../hooks/useRouteState";
import { useCodeWrap } from "../../lib/diffSettingsStore";
import { overlayToNavigation } from "../../lib/navigation";
import { getFileViewState } from "../../utils/fileView";
import FileBody, { offersWrap } from "../Files/FileBody";
import { DownloadButton } from "../Files/FileDownloadControls";
import { FilePageHeader } from "../Layout/PageHeader";
import {
	ContentView,
	DetailActionBottomBar,
	type DetailActions,
	type DetailActionsPlacement,
	SourceToggle,
	sourceRenderingOf,
	ToggleIconButton,
	ViewToolbar,
	WrapToggle,
} from "../ui";

interface Props {
	hash: string;
	path: string;
	/** Up to its diff, which may not be the entry behind. */
	onBack: () => void;
	/** Where the actions are drawn; see `DetailActionsPlacement`. */
	actionsAt?: DetailActionsPlacement;
}

/**
 * A file as one commit left it.
 *
 * Read-only throughout: history cannot be edited, so its actions hold no
 * write action at all rather than a disabled one, which would read as a bug or
 * a permission problem.
 */
function CommitFileView({ hash, path, onBack, actionsAt = "bottom" }: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId } = useRouteState();
	// Kept across files: someone reading several historical files in a row
	// should not have to press it again for each.
	const [plain, setPlain] = useState(false);
	const { wrap } = useCodeWrap();
	const { data: commit } = useGitCommit(hash);
	const { data: file, isLoading, error } = useCommitFile(hash, path);
	const [downloadError, setDownloadError] = useState<string | null>(null);
	const download = useFileDownload({
		path,
		worktree,
		hash,
		onError: setDownloadError,
	});

	// The view is reused across files, so a failure belongs to the one it was
	// reported for.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the file's identity is the trigger, not values the body reads
	useEffect(() => {
		setDownloadError(null);
	}, [hash, path, worktree]);

	const state = useMemo(
		() =>
			file ? getFileViewState(file, { kind: "commit", hash, path }) : null,
		[file, hash, path],
	);

	// The working tree's file: that is what a relative image was read from.
	const openFile = useCallback(
		(target: string) => {
			navigate(
				overlayToNavigation(
					{ type: "file", path: target },
					worktree,
					sessionId,
				),
			);
		},
		[navigate, worktree, sessionId],
	);

	const shortHash = hash.substring(0, 7);
	const isPage = state?.kind === "page";

	// Absent rather than present and inert wherever it could not change
	// anything: an image or a binary has no rendering to drop to source, and a
	// file past `HIGHLIGHT_LIMIT` is already plain with a banner that says so.
	// A page, of any size, has: its source. Markdown and pages switch between a
	// rendering and its source; other highlighted text drops to plain text,
	// the only way to its copy button.
	const sourceRendering = sourceRenderingOf(state, path);
	const togglePlain = () => setPlain((v) => !v);
	const sourceToggle = sourceRendering ? (
		<SourceToggle
			rendering={sourceRendering}
			showingSource={plain}
			onToggle={togglePlain}
		/>
	) : (
		state?.kind === "text" &&
		state.highlight && (
			<ToggleIconButton
				icon={Type}
				pressed={plain}
				onClick={togglePlain}
				label={plain ? "Show rendered" : "Show plain text"}
			/>
		)
	);
	const wrapToggle = state && offersWrap(state, path, { plain }) && (
		<WrapToggle />
	);
	const toggles = (sourceToggle || wrapToggle) && (
		<>
			{sourceToggle}
			{wrapToggle}
		</>
	);
	const actions: DetailActions = {
		utilities: state && <DownloadButton download={download} />,
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<FilePageHeader
				path={path}
				status={shortHash}
				mono
				back={{ to: "parent", label: "Back to diff", onClick: onBack }}
			/>
			<ViewToolbar toggles={toggles} actions={actions} actionsAt={actionsAt} />
			<ContentView
				isLoading={isLoading}
				error={error instanceof Error ? error : null}
				fill={isPage && !plain}
			>
				{/* One banner for both facts: which version this is and that it
				    cannot be changed. Two would read as two separate problems. */}
				<div className="flex gap-1 border-b border-th-border bg-th-bg-secondary px-4 py-2 text-xs text-th-text-muted">
					<span className="shrink-0">
						Read-only — this file as of <code>{shortHash}</code>
					</span>
					{commit && <span className="truncate">· {commit.subject}</span>}
				</div>
				{downloadError && (
					<div className="border-b border-th-error/20 bg-th-error/10 px-4 py-2 text-sm text-th-error">
						{downloadError}
					</div>
				)}
				{state && (
					<FileBody
						state={state}
						path={path}
						plain={plain}
						readOnly
						lineNumbers
						wrap={wrap}
						onOpenFile={openFile}
						downloadAction={{ label: download.label, onClick: download.toggle }}
					/>
				)}
			</ContentView>
			<DetailActionBottomBar actions={actions} actionsAt={actionsAt} />
		</div>
	);
}

export default CommitFileView;
