import { MoreHorizontal } from "lucide-react";
import { memo } from "react";
import type { GitCommit } from "../../types/git";
import { formatRelativeDate } from "../../utils/relativeTime";
import SidebarListItem from "../common/SidebarListItem";
import { iconButtonClass } from "./iconButtonClass";

interface Props {
	commits: GitCommit[];
	activeHash: string | null;
	onSelectCommit: (hash: string) => void;
	/**
	 * Amends the commit this row shows. Offered on the first row only, which is
	 * HEAD: git.Log reads `git log` from HEAD in reverse-chronological order.
	 */
	onAmend?: () => void;
}

const CommitItem = memo(function CommitItem({
	commit,
	isActive,
	onSelect,
	onAmend,
}: {
	commit: GitCommit;
	isActive: boolean;
	onSelect: (hash: string) => void;
	onAmend?: () => void;
}) {
	const shortHash = commit.hash.substring(0, 7);

	return (
		<SidebarListItem
			title={commit.subject}
			subtitle={
				<span className="flex items-center gap-1.5">
					<span className="shrink-0 font-mono">{shortHash}</span>
					<span className="truncate">
						{commit.author}, {formatRelativeDate(commit.date)}
					</span>
				</span>
			}
			isActive={isActive}
			onSelect={() => onSelect(commit.hash)}
			ariaLabel={`View commit ${shortHash}: ${commit.subject}`}
			actions={
				onAmend && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onAmend();
						}}
						aria-label="Amend this commit"
						className={iconButtonClass()}
					>
						<MoreHorizontal className="h-4 w-4" aria-hidden="true" />
					</button>
				)
			}
		/>
	);
});

function LogList({ commits, activeHash, onSelectCommit, onAmend }: Props) {
	if (commits.length === 0) {
		return (
			<div className="px-3 py-2 text-sm text-th-text-muted">No commits yet</div>
		);
	}

	return (
		<div className="flex flex-col gap-1 px-2 pb-2">
			{commits.map((commit, index) => (
				<CommitItem
					key={commit.hash}
					commit={commit}
					isActive={commit.hash === activeHash}
					onSelect={onSelectCommit}
					onAmend={index === 0 ? onAmend : undefined}
				/>
			))}
		</div>
	);
}

export default LogList;
