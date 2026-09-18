import { useNavigate } from "@tanstack/react-router";
import {
	ALargeSmall,
	ChevronLeft,
	ChevronRight,
	Loader2,
	Minus,
	Plus,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useGitDiffWatch } from "../../hooks/useGitDiffWatch";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useGitWriteRunner } from "../../hooks/useGitWrites";
import { useRouteState } from "../../hooks/useRouteState";
import { useDiffSettings } from "../../lib/diffSettingsStore";
import { overlayToNavigation } from "../../lib/navigation";
import { flattenGitStatus, stageFailureSummary } from "../../types/git";
import { describeGitFailure, type GitFailure } from "../../utils/gitErrors";
import {
	BottomActionBar,
	ContentView,
	getActionIconButtonClass,
	ToggleIconButton,
} from "../ui";
import DiffContent from "./DiffContent";
import ErrorBanner from "./ErrorBanner";

interface Props {
	path: string;
	staged: boolean;
	onBack: () => void;
}

function DiffView({ path, staged, onBack }: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId } = useRouteState();
	const { hideWhitespace, toggleHideWhitespace } = useDiffSettings();
	const { data: diff, isLoading } = useGitDiffWatch({
		path,
		staged,
		hideWhitespace,
	});
	const { data: gitStatus } = useGitStatus();
	const { toggle, writes } = useGitWriteRunner();
	const [error, setError] = useState<GitFailure | null>(null);

	const allFiles = useMemo(() => {
		if (!gitStatus) return [];
		const flat = flattenGitStatus(gitStatus);
		return [
			...flat.staged.map((f) => ({ ...f, staged: true })),
			...flat.unstaged.map((f) => ({ ...f, staged: false })),
		];
	}, [gitStatus]);

	const currentIndex = allFiles.findIndex(
		(f) => f.path === path && f.staged === staged,
	);
	const prev = currentIndex > 0 ? allFiles[currentIndex - 1] : null;
	const next =
		currentIndex >= 0 && currentIndex < allFiles.length - 1
			? allFiles[currentIndex + 1]
			: null;

	const navigateTo = (file: { path: string; staged: boolean }) => {
		navigate(
			overlayToNavigation(
				{ type: "diff", path: file.path, staged: file.staged },
				worktree,
				sessionId,
			),
		);
	};

	// Any pending write on this file, not just a stage: a discard started from
	// the file list would otherwise leave this button live, and the write store
	// drops a path it is already writing — the tap would navigate to the other
	// side of a stage that never happened.
	const isBusy = writes.toggling.has(path) || writes.discarding.has(path);

	const handleToggleStage = async () => {
		setError(null);
		try {
			await toggle([path], staged);
			navigate(
				overlayToNavigation(
					{ type: "diff", path, staged: !staged },
					worktree,
					sessionId,
				),
			);
		} catch (e) {
			// The view stays where it is: the file did not move, so neither does
			// the diff the user is reading.
			setError(describeGitFailure(e, () => stageFailureSummary(staged)));
		}
	};

	const stageButtonLabel = staged ? "Unstage" : "Stage";
	const StageIcon = staged ? Minus : Plus;
	const stageButtonColor = staged ? "text-th-warning" : "text-th-success";

	const handlePathClick = () => {
		navigate(overlayToNavigation({ type: "file", path }, worktree, sessionId));
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			{error && (
				<ErrorBanner
					summary={error.summary}
					details={error.detail}
					onDismiss={() => setError(null)}
				/>
			)}
			<ContentView
				path={path}
				pathColor={staged ? "text-th-success" : "text-th-warning"}
				isLoading={isLoading}
				onBack={onBack}
				onPathClick={handlePathClick}
			>
				{diff !== undefined && (
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
							onClick={() => prev && navigateTo(prev)}
							className={getActionIconButtonClass(!!prev)}
							aria-label="Previous file"
						>
							<ChevronLeft className="h-4 w-4" aria-hidden="true" />
						</button>
						<button
							type="button"
							disabled={!next}
							onClick={() => next && navigateTo(next)}
							className={getActionIconButtonClass(!!next)}
							aria-label="Next file"
						>
							<ChevronRight className="h-4 w-4" aria-hidden="true" />
						</button>
					</div>
					<div className="flex items-center gap-2">
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
						<button
							type="button"
							onClick={handleToggleStage}
							disabled={isBusy}
							className={`flex items-center gap-1.5 rounded border border-th-border bg-th-bg-tertiary h-9 px-3 text-xs transition-all pointer-coarse:h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
								isBusy
									? "opacity-50 cursor-not-allowed text-th-text-muted"
									: `${stageButtonColor} hover:border-th-border-focus`
							}`}
							aria-label={stageButtonLabel}
						>
							{isBusy ? (
								<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
							) : (
								<StageIcon className="h-4 w-4" aria-hidden="true" />
							)}
							{stageButtonLabel}
						</button>
					</div>
				</div>
			</BottomActionBar>
		</div>
	);
}

export default DiffView;
