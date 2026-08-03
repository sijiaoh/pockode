import { GitBranch } from "lucide-react";
import { useWorktreeDisplay } from "../../hooks/useWorktreeDisplay";
import { useIsGitRepo } from "../../lib/worktreeStore";

interface Props {
	/** The work's raw `worktree` field (empty/undefined = main). */
	worktree: string | undefined;
	/** Extra classes for layout, e.g. `max-w-*` in dense list rows. */
	className?: string;
}

function WorktreeBadge({ worktree, className }: Props) {
	const isGitRepo = useIsGitRepo();
	const { displayName, isMain } = useWorktreeDisplay(worktree);

	// Non-git projects have no worktree concept, so the main badge is just noise.
	if (isMain && !isGitRepo) return null;

	const label = isMain
		? "Runs on default (main) worktree"
		: `Worktree: ${displayName}`;

	return (
		<span
			className={`inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
				isMain ? "text-th-text-muted" : "bg-th-accent/10 text-th-accent"
			} ${className ?? ""}`}
			title={displayName}
			role="img"
			aria-label={label}
		>
			<GitBranch className="size-3 shrink-0" aria-hidden="true" />
			<span className="truncate">{displayName}</span>
		</span>
	);
}

export default WorktreeBadge;
