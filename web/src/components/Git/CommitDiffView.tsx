import { useNavigate } from "@tanstack/react-router";
import { ALargeSmall, FileClock, History } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { useCommitDiff } from "../../hooks/useCommitDiff";
import { useGitCommit } from "../../hooks/useGitCommit";
import { usePrefillComposer } from "../../hooks/usePrefillComposer";
import { useRouteState } from "../../hooks/useRouteState";
import { type DiffHunk, parseHunks } from "../../lib/diffHunks";
import { useDiffSettings } from "../../lib/diffSettingsStore";
import { overlayToNavigation } from "../../lib/navigation";
import { commitOriginOf, fileHistoryOverlay } from "../../types/overlay";
import { splitPath } from "../../utils/path";
import { FilePageHeader } from "../Layout/PageHeader";
import {
	ContentView,
	DetailActionBottomBar,
	type DetailActions,
	type DetailActionsPlacement,
	getActionIconButtonClass,
	ToggleIconButton,
	ViewToolbar,
	WrapToggle,
} from "../ui";
import DiffContent from "./DiffContent";
import ErrorBanner from "./ErrorBanner";
import FileSequenceNav from "./FileSequenceNav";
import HunkBar from "./HunkBar";
import { useLineSelection } from "./useLineSelection";

interface Props {
	hash: string;
	path: string;
	/** Up to its commit, which may not be the entry behind. */
	onBack: () => void;
	/** Where the file's actions are drawn; see `DetailActionsPlacement`. */
	actionsAt?: DetailActionsPlacement;
}

function CommitDiffView({ hash, path, onBack, actionsAt = "bottom" }: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId, overlay } = useRouteState();
	// Carried from layer to layer, so going up lands on the list the commit
	// was picked from (docs/git-history-ui.md#url), or the branch
	// (docs/git-branches-ui.md#opening-a-commit).
	const origin = commitOriginOf(overlay);
	const { hideWhitespace, toggleHideWhitespace } = useDiffSettings();
	const { data: commit } = useGitCommit(hash);
	const {
		data: diff,
		isLoading,
		error,
	} = useCommitDiff({
		hash,
		path,
		hideWhitespace,
	});

	const files = useMemo(() => commit?.files ?? [], [commit]);
	const currentIndex = files.findIndex((f) => f.path === path);
	const currentFile = currentIndex >= 0 ? files[currentIndex] : null;
	const prev = currentIndex > 0 ? files[currentIndex - 1] : null;
	const next =
		currentIndex >= 0 && currentIndex < files.length - 1
			? files[currentIndex + 1]
			: null;

	const navigateToFile = (filePath: string) => {
		navigate(
			overlayToNavigation(
				{ type: "commit-diff", hash, path: filePath, ...origin },
				worktree,
				sessionId,
			),
		);
	};

	const handlePathClick = () => {
		navigate(overlayToNavigation({ type: "file", path }, worktree, sessionId));
	};

	const viewCommitVersion = () => {
		navigate(
			overlayToNavigation(
				{ type: "commit-file", hash, path, ...origin },
				worktree,
				sessionId,
			),
		);
	};

	const openHistory = () => {
		navigate(
			overlayToNavigation(fileHistoryOverlay(path), worktree, sessionId),
		);
	};

	const shortHash = hash.substring(0, 7);

	// Lines selected for Copy and Ask AI, as in the review; the draft names
	// the commit, since these lines are history and not what is on disk.
	const prefill = usePrefillComposer();
	const hunks = useMemo(
		() => (diff && !diff.omitted ? parseHunks(diff.diff) : []),
		[diff],
	);
	const bodyRef = useRef<HTMLDivElement>(null);
	const { selectHunk, onLinePress, selectedLines, announcement, bar } =
		useLineSelection({
			path,
			diff,
			hunks,
			source: { kind: "commit", hash },
			scope: String(hideWhitespace),
			bodyRef,
			prefill,
		});
	// The review's bars without the stage button: a hunk's Select is the way
	// to a selection without a pointer, and where focus goes back to.
	const renderHunkBar = useCallback(
		(hunk: DiffHunk, index: number) => (
			<HunkBar hunk={hunk} index={index} onSelect={() => selectHunk(index)} />
		),
		[selectHunk],
	);
	// A commit that deletes a file holds no blob for it, so there is no version
	// here to show. The reason travels with the control rather than leaving it
	// silently greyed out, as with `getEditLabel`.
	const deletedHere = currentFile?.status === "D";
	const versionLabel = deletedHere
		? `View this file at ${shortHash} (deleted in this commit)`
		: `View this file at ${shortHash}`;

	const actions: DetailActions = {
		utilities: (
			<>
				<button
					type="button"
					onClick={openHistory}
					className={getActionIconButtonClass(true)}
					aria-label="History of this file"
					title="History of this file"
				>
					<History className="h-4 w-4" aria-hidden="true" />
				</button>
				<button
					type="button"
					disabled={deletedHere}
					onClick={viewCommitVersion}
					className={getActionIconButtonClass(!deletedHere)}
					aria-label={versionLabel}
					title={versionLabel}
				>
					<FileClock className="h-4 w-4" aria-hidden="true" />
				</button>
			</>
		),
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<FilePageHeader
				path={path}
				status={shortHash}
				mono
				back={{ to: "parent", label: "Back to commit", onClick: onBack }}
				onTitleClick={handlePathClick}
				titleActionLabel={`Open current ${splitPath(path).fileName}`}
			/>
			<ViewToolbar
				nav={
					<FileSequenceNav
						onPrevious={prev ? () => navigateToFile(prev.path) : undefined}
						onNext={next ? () => navigateToFile(next.path) : undefined}
						count={
							commit && {
								position: currentIndex >= 0 ? currentIndex + 1 : null,
								total: files.length,
								absentLabel: `Not in this commit, ${files.length} files`,
							}
						}
					/>
				}
				toggles={
					<>
						<WrapToggle />
						<ToggleIconButton
							icon={ALargeSmall}
							pressed={hideWhitespace}
							onClick={toggleHideWhitespace}
							label={
								hideWhitespace
									? "Show whitespace changes"
									: "Hide whitespace changes"
							}
						/>
					</>
				}
				actions={actions}
				actionsAt={actionsAt}
			/>
			{prefill.error && (
				<ErrorBanner
					summary={prefill.error.summary}
					details={prefill.error.detail}
					onDismiss={prefill.dismissError}
				/>
			)}
			<p className="sr-only" aria-live="polite">
				{announcement}
			</p>
			<ContentView isLoading={isLoading} error={error ?? undefined}>
				{diff && (
					<div ref={bodyRef}>
						<DiffContent
							data={diff}
							fileName={path}
							renderHunkBar={renderHunkBar}
							onLinePress={onLinePress}
							selectedLines={selectedLines}
						/>
					</div>
				)}
			</ContentView>
			{bar}
			<DetailActionBottomBar actions={actions} actionsAt={actionsAt} />
		</div>
	);
}

export default CommitDiffView;
