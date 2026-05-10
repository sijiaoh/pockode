import { useNavigate } from "@tanstack/react-router";
import { ALargeSmall, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useCommitDiff } from "../../hooks/useCommitDiff";
import { useGitCommit } from "../../hooks/useGitCommit";
import { useRouteState } from "../../hooks/useRouteState";
import { useDiffSettings } from "../../lib/diffSettingsStore";
import { overlayToNavigation } from "../../lib/navigation";
import { BottomActionBar, ContentView, getActionIconButtonClass } from "../ui";
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

	const handleBack = () => {
		navigate(
			overlayToNavigation({ type: "commit", hash }, worktree, sessionId),
		);
	};

	const shortHash = hash.substring(0, 7);

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={path}
				pathColor="text-th-accent"
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
					<div className="flex items-center gap-1">
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
							onClick={toggleHideWhitespace}
							aria-pressed={hideWhitespace}
							aria-label={
								hideWhitespace
									? "Show whitespace changes"
									: "Hide whitespace changes"
							}
							title={
								hideWhitespace
									? "Show whitespace changes"
									: "Hide whitespace changes"
							}
							className={`flex h-8 w-8 items-center justify-center rounded border transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
								hideWhitespace
									? "bg-th-accent text-th-accent-text border-th-accent"
									: "text-th-text-muted hover:text-th-text-secondary border-th-border bg-th-bg-tertiary hover:border-th-border-focus"
							}`}
						>
							<ALargeSmall className="h-4 w-4" aria-hidden="true" />
						</button>
						<div className="text-xs text-th-text-muted">{shortHash}</div>
					</div>
				</div>
			</BottomActionBar>
		</div>
	);
}

export default CommitDiffView;
