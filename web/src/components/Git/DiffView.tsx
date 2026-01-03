import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useGitDiff } from "../../hooks/useGitDiff";
import { useGitStatus } from "../../hooks/useGitStatus";
import type { OverlaySearchParams } from "../../router";
import { ContentView } from "../ui";
import DiffContent from "./DiffContent";

interface Props {
	path: string;
	staged: boolean;
	onBack: () => void;
}

const navButtonClass = (enabled: boolean) =>
	`flex items-center justify-center rounded-md border border-th-border bg-th-bg-tertiary min-h-[44px] min-w-[44px] p-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
		enabled
			? "text-th-text-secondary hover:border-th-border-focus hover:bg-th-bg-primary hover:text-th-text-primary active:scale-[0.97]"
			: "cursor-not-allowed opacity-40"
	}`;

function DiffView({ path, staged, onBack }: Props) {
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as OverlaySearchParams;
	const sessionId = search.session;
	const { data: diff, isLoading, error } = useGitDiff({ path, staged });
	const { data: gitStatus } = useGitStatus();

	const allFiles = useMemo(() => {
		if (!gitStatus) return [];
		return [
			...gitStatus.staged.map((f) => ({ ...f, staged: true })),
			...gitStatus.unstaged.map((f) => ({ ...f, staged: false })),
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
		navigate({
			to: file.staged ? "/staged/$" : "/unstaged/$",
			params: { _splat: file.path },
			search: sessionId ? { session: sessionId } : {},
		});
	};

	const headerActions = (
		<div className="flex items-center">
			<button
				type="button"
				disabled={!prev}
				onClick={() => prev && navigateTo(prev)}
				className={navButtonClass(!!prev)}
				aria-label="Previous file"
			>
				<ChevronLeft className="h-5 w-5" aria-hidden="true" />
			</button>
			<button
				type="button"
				disabled={!next}
				onClick={() => next && navigateTo(next)}
				className={navButtonClass(!!next)}
				aria-label="Next file"
			>
				<ChevronRight className="h-5 w-5" aria-hidden="true" />
			</button>
		</div>
	);

	const handlePathClick = () => {
		navigate({
			to: "/files/$",
			params: { _splat: path },
			search: sessionId ? { session: sessionId } : {},
		});
	};

	return (
		<ContentView
			path={path}
			pathColor={staged ? "text-th-success" : "text-th-warning"}
			isLoading={isLoading}
			error={error instanceof Error ? error : null}
			onBack={onBack}
			onPathClick={handlePathClick}
			headerActions={headerActions}
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
	);
}

export default DiffView;
