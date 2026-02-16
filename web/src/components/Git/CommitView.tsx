import { useNavigate } from "@tanstack/react-router";
import { useGitCommit } from "../../hooks/useGitCommit";
import { useRouteState } from "../../hooks/useRouteState";
import { overlayToNavigation } from "../../lib/navigation";
import {
	type FileChange,
	GIT_STATUS_INFO,
	type GitFileStatus,
} from "../../types/git";
import { BottomActionBar, ContentView } from "../ui";

function formatDate(isoDate: string): string {
	const date = new Date(isoDate);
	if (Number.isNaN(date.getTime())) {
		return isoDate;
	}
	return date.toLocaleString();
}

interface Props {
	hash: string;
	onBack: () => void;
}

function FileChangeItem({
	file,
	onClick,
}: {
	file: FileChange;
	onClick: () => void;
}) {
	const statusInfo =
		GIT_STATUS_INFO[file.status as GitFileStatus] ?? GIT_STATUS_INFO["?"];

	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-[44px] items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-th-bg-tertiary rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
		>
			<span className={`font-mono ${statusInfo.color}`}>{file.status}</span>
			<span className="truncate text-th-text-primary">{file.path}</span>
		</button>
	);
}

function CommitView({ hash, onBack }: Props) {
	const navigate = useNavigate();
	const { worktree, sessionId } = useRouteState();
	const { data: commit, isLoading, error } = useGitCommit(hash);

	const shortHash = hash.substring(0, 7);

	const handleFileClick = (path: string) => {
		navigate(
			overlayToNavigation(
				{ type: "commit-diff", hash, path },
				worktree,
				sessionId,
			),
		);
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<ContentView
				path={commit?.subject ?? shortHash}
				pathColor="text-th-accent"
				isLoading={isLoading}
				error={error ?? undefined}
				onBack={onBack}
			>
				{commit && (
					<div className="flex flex-col">
						{/* Commit metadata */}
						<div className="border-b border-th-border p-4">
							<div className="font-medium text-th-text-primary">
								{commit.subject}
							</div>
							{commit.body && (
								<p className="mt-2 whitespace-pre-wrap text-sm text-th-text-secondary">
									{commit.body}
								</p>
							)}
							<div className="mt-3 text-xs text-th-text-muted">
								<div>{commit.author}</div>
								<div>{formatDate(commit.date)}</div>
								<div className="mt-1 font-mono">{commit.hash}</div>
							</div>
						</div>

						{/* Changed files */}
						{commit.files && commit.files.length > 0 && (
							<div className="p-4">
								<div className="mb-2 text-xs uppercase text-th-text-muted">
									Changed files ({commit.files.length})
								</div>
								<div className="flex flex-col">
									{commit.files.map((file) => (
										<FileChangeItem
											key={file.path}
											file={file}
											onClick={() => handleFileClick(file.path)}
										/>
									))}
								</div>
							</div>
						)}
					</div>
				)}
			</ContentView>
			<BottomActionBar>
				<div className="text-xs text-th-text-muted">{shortHash}</div>
			</BottomActionBar>
		</div>
	);
}

export default CommitView;
