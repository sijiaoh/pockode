import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus } from "lucide-react";
import { useMemo } from "react";
import { useGitDiffWatch } from "../../hooks/useGitDiffWatch";
import { useGitStage } from "../../hooks/useGitStage";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useRouteState } from "../../hooks/useRouteState";
import { overlayToNavigation } from "../../lib/navigation";
import { flattenGitStatus } from "../../types/git";
import { BottomActionBar, ContentView } from "../ui";
import DiffContent from "./DiffContent";

interface Props {
	path: string;
	staged: boolean;
	onBack: () => void;
}

const getNavButtonClass = (enabled: boolean) =>
	`flex items-center justify-center rounded border border-th-border bg-th-bg-tertiary h-8 w-8 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
		enabled
			? "text-th-text-secondary hover:border-th-border-focus hover:text-th-text-primary active:scale-95"
			: "cursor-not-allowed opacity-50"
	}`;

function DiffView({ path, staged, onBack }: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId } = useRouteState();
	const { data: diff, isLoading } = useGitDiffWatch({ path, staged });
	const { data: gitStatus } = useGitStatus();
	const { stageMutation, unstageMutation } = useGitStage();

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

	const isToggling = stageMutation.isPending || unstageMutation.isPending;

	const handleToggleStage = async () => {
		try {
			if (staged) {
				await unstageMutation.mutateAsync([path]);
			} else {
				await stageMutation.mutateAsync([path]);
			}
			navigate(
				overlayToNavigation(
					{ type: "diff", path, staged: !staged },
					worktree,
					sessionId,
				),
			);
		} catch {
			// Error is already handled by React Query - user sees the error state
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
					<div className="flex items-center">
						<button
							type="button"
							disabled={!prev}
							onClick={() => prev && navigateTo(prev)}
							className={getNavButtonClass(!!prev)}
							aria-label="Previous file"
						>
							<ChevronLeft className="h-4 w-4" aria-hidden="true" />
						</button>
						<button
							type="button"
							disabled={!next}
							onClick={() => next && navigateTo(next)}
							className={getNavButtonClass(!!next)}
							aria-label="Next file"
						>
							<ChevronRight className="h-4 w-4" aria-hidden="true" />
						</button>
					</div>
					<button
						type="button"
						onClick={handleToggleStage}
						disabled={isToggling}
						className={`flex items-center gap-1.5 rounded border border-th-border bg-th-bg-tertiary h-8 px-3 text-xs transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
							isToggling
								? "opacity-50 cursor-not-allowed text-th-text-muted"
								: `${stageButtonColor} hover:border-th-border-focus`
						}`}
						aria-label={stageButtonLabel}
					>
						{isToggling ? (
							<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						) : (
							<StageIcon className="h-4 w-4" aria-hidden="true" />
						)}
						{stageButtonLabel}
					</button>
				</div>
			</BottomActionBar>
		</div>
	);
}

export default DiffView;
