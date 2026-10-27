import { useState } from "react";
import { useGitLog } from "../../hooks/useGitLog";
import { Spinner } from "../ui";
import GitCommitSheet from "./GitCommitSheet";
import LogList from "./LogList";

interface Props {
	activeHash: string | null;
	onSelectCommit: (hash: string) => void;
}

/** The Git workspace's History segment: the commit log, HEAD first. */
function HistorySection({ activeHash, onSelectCommit }: Props) {
	const { data, isLoading, error } = useGitLog();
	// Opened from the HEAD row's amend action.
	const [isAmending, setIsAmending] = useState(false);

	return (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{isLoading ? (
					<div className="flex items-center justify-center p-8">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				) : data ? (
					// A refetch that fails keeps the log already on screen: it is
					// still what HEAD was a moment ago.
					<div className="pt-2">
						<LogList
							commits={data.commits}
							activeHash={activeHash}
							onSelectCommit={onSelectCommit}
							onAmend={() => setIsAmending(true)}
						/>
					</div>
				) : (
					error && (
						<div className="p-4 text-center text-th-error">
							<div>Failed to load history</div>
							<div className="mt-1 text-sm text-th-text-muted">
								{error instanceof Error ? error.message : String(error)}
							</div>
						</div>
					)
				)}
			</div>

			{isAmending && (
				<GitCommitSheet
					amendInitially={true}
					onClose={() => setIsAmending(false)}
				/>
			)}
		</>
	);
}

export default HistorySection;
