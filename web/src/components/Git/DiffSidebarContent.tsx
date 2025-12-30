import { useGitStatus } from "../../hooks/useGitStatus";
import { Spinner } from "../ui";
import DiffFileList from "./DiffFileList";

interface Props {
	onSelectFile: (path: string, staged: boolean) => void;
	activeFile: { path: string; staged: boolean } | null;
}

function DiffSidebarContent({ onSelectFile, activeFile }: Props) {
	const { data: status, isLoading, error } = useGitStatus();

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8">
				<Spinner className="text-th-text-muted" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-4 text-center text-th-error">
				<div className="font-medium">Failed to load git status</div>
				<div className="mt-1 text-sm text-th-text-muted">
					{error instanceof Error ? error.message : String(error)}
				</div>
			</div>
		);
	}

	if (!status || (status.staged.length === 0 && status.unstaged.length === 0)) {
		return (
			<div className="p-4 text-center text-th-text-muted">
				No changes to display
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col gap-4 overflow-y-auto py-2">
			<DiffFileList
				title="Staged"
				files={status.staged}
				staged={true}
				onSelectFile={onSelectFile}
				activeFile={activeFile}
			/>
			<DiffFileList
				title="Unstaged"
				files={status.unstaged}
				staged={false}
				onSelectFile={onSelectFile}
				activeFile={activeFile}
			/>
		</div>
	);
}

export default DiffSidebarContent;
