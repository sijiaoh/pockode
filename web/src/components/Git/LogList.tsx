import { memo } from "react";
import type { GitCommit } from "../../types/git";
import { formatRelativeDate } from "../../utils/relativeTime";

interface Props {
	commits: GitCommit[];
	activeHash: string | null;
	onSelectCommit: (hash: string) => void;
}

const CommitItem = memo(function CommitItem({
	commit,
	isActive,
	onSelect,
}: {
	commit: GitCommit;
	isActive: boolean;
	onSelect: (hash: string) => void;
}) {
	const shortHash = commit.hash.substring(0, 7);

	return (
		<button
			type="button"
			onClick={() => onSelect(commit.hash)}
			className={`flex w-full min-h-[44px] flex-col justify-center gap-0.5 rounded-lg px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${
				isActive
					? "bg-th-bg-tertiary border-l-2 border-th-accent"
					: "hover:bg-th-bg-tertiary"
			}`}
			aria-label={`View commit ${shortHash}: ${commit.subject}`}
		>
			<div className="truncate text-sm text-th-text-primary">
				{commit.subject}
			</div>
			<div className="flex items-center gap-1.5 text-xs text-th-text-muted">
				<span className="font-mono shrink-0">{shortHash}</span>
				<span className="truncate">
					{commit.author}, {formatRelativeDate(commit.date)}
				</span>
			</div>
		</button>
	);
});

function LogList({ commits, activeHash, onSelectCommit }: Props) {
	if (commits.length === 0) {
		return (
			<div className="px-3 py-2 text-sm text-th-text-muted">No commits yet</div>
		);
	}

	return (
		<div className="flex flex-col gap-1 px-2 pb-2">
			{commits.map((commit) => (
				<CommitItem
					key={commit.hash}
					commit={commit}
					isActive={commit.hash === activeHash}
					onSelect={onSelectCommit}
				/>
			))}
		</div>
	);
}

export default LogList;
