import type { GitCommit } from "../../types/git";

interface Props {
	commits: GitCommit[];
	activeHash: string | null;
	onSelectCommit: (hash: string) => void;
}

function formatRelativeDate(isoDate: string): string {
	const date = new Date(isoDate);
	if (Number.isNaN(date.getTime())) {
		return isoDate; // Fallback to raw string if parsing fails
	}

	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / (1000 * 60));
	const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays === 1) return "yesterday";
	if (diffDays < 7) return `${diffDays}d ago`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
	return `${Math.floor(diffDays / 365)}y ago`;
}

function CommitItem({
	commit,
	isActive,
	onSelect,
}: {
	commit: GitCommit;
	isActive: boolean;
	onSelect: () => void;
}) {
	const shortHash = commit.hash.substring(0, 7);

	return (
		<button
			type="button"
			onClick={onSelect}
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
				<span className="truncate">{commit.author}, {formatRelativeDate(commit.date)}</span>
			</div>
		</button>
	);
}

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
					onSelect={() => onSelectCommit(commit.hash)}
				/>
			))}
		</div>
	);
}

export default LogList;
