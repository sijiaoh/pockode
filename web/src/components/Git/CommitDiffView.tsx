import { useNavigate } from "@tanstack/react-router";
import {
	ALargeSmall,
	ChevronLeft,
	ChevronRight,
	FileClock,
} from "lucide-react";
import { useMemo } from "react";
import { useCommitDiff } from "../../hooks/useCommitDiff";
import { useGitCommit } from "../../hooks/useGitCommit";
import { useRouteState } from "../../hooks/useRouteState";
import { useDiffSettings } from "../../lib/diffSettingsStore";
import { overlayToNavigation } from "../../lib/navigation";
import { splitPath } from "../../utils/path";
import {
	BottomActionBar,
	ContentView,
	getActionIconButtonClass,
	ToggleIconButton,
} from "../ui";
import DiffContent from "./DiffContent";

interface Props {
	hash: string;
	path: string;
}

function CommitDiffView({ hash, path }: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId } = useRouteState();
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
				{ type: "commit-diff", hash, path: filePath },
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
				{ type: "commit-file", hash, path },
				worktree,
				sessionId,
			),
		);
	};

	const handleBack = () => {
		navigate(
			overlayToNavigation({ type: "commit", hash }, worktree, sessionId),
		);
	};

	const shortHash = hash.substring(0, 7);
	// A commit that deletes a file holds no blob for it, so there is no version
	// here to show. The reason travels with the control rather than leaving it
	// silently greyed out, as with `getEditLabel`.
	const deletedHere = currentFile?.status === "D";
	const versionLabel = deletedHere
		? `View this file at ${shortHash} (deleted in this commit)`
		: `View this file at ${shortHash}`;

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={path}
				pathColor="text-th-accent"
				onPathClick={handlePathClick}
				pathActionLabel={`Open current ${splitPath(path).fileName}`}
				isLoading={isLoading}
				error={error ?? undefined}
				onBack={handleBack}
			>
				{diff && (
					<DiffContent
						diff={diff.diff}
						fileName={path}
						oldContent={diff.old_content}
						newContent={diff.new_content}
					/>
				)}
			</ContentView>
			<BottomActionBar>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1 pointer-coarse:gap-2">
						<button
							type="button"
							disabled={!prev}
							onClick={() => prev && navigateToFile(prev.path)}
							className={getActionIconButtonClass(!!prev)}
							aria-label="Previous file"
						>
							<ChevronLeft className="h-4 w-4" aria-hidden="true" />
						</button>
						<button
							type="button"
							disabled={!next}
							onClick={() => next && navigateToFile(next.path)}
							className={getActionIconButtonClass(!!next)}
							aria-label="Next file"
						>
							<ChevronRight className="h-4 w-4" aria-hidden="true" />
						</button>
					</div>
					<div className="flex items-center gap-2">
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
						<div className="text-xs text-th-text-muted">{shortHash}</div>
					</div>
				</div>
			</BottomActionBar>
		</div>
	);
}

export default CommitDiffView;
