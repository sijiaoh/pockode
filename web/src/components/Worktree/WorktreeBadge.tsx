import { Link } from "@tanstack/react-router";
import { GitBranch } from "lucide-react";
import { useWorktreeDisplay } from "../../hooks/useWorktreeDisplay";
import { buildNavigation } from "../../lib/navigation";
import { isWorktreeBound, useWorkStore } from "../../lib/workStore";
import { useIsGitRepo } from "../../lib/worktreeStore";
import type { Work } from "../../types/work";

interface Props {
	/** The work whose worktree assignment is shown. */
	work: Pick<Work, "id" | "parent_id" | "status" | "worktree">;
	/** Extra classes for layout, e.g. `max-w-*` in dense list rows. */
	className?: string;
}

function WorktreeBadge({ work, className }: Props) {
	const { worktree } = work;
	const isGitRepo = useIsGitRepo();
	const { displayName, isMain } = useWorktreeDisplay(worktree);
	const isBound = useWorkStore((s) => isWorktreeBound(s.works, work));

	// A worktree that the backend can still rewrite would be misleading to show,
	// so an undecided binding renders nothing rather than a provisional name.
	if (!isBound) return null;

	// Non-git projects have no worktree concept, so the main badge is just noise.
	if (isMain && !isGitRepo) return null;

	const label = isMain ? "Open main worktree" : `Open worktree ${displayName}`;

	// Jump to the worktree root (no work/chat context); `replace` is ignored so
	// the navigation pushes a history entry.
	const { to, params, search } = buildNavigation({
		type: "home",
		worktree: worktree ?? "",
	});

	const variantClass = isMain
		? "text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-secondary active:bg-th-bg-tertiary focus-visible:ring-th-border-focus"
		: "bg-th-accent/10 text-th-accent hover:bg-th-accent/20 hover:text-th-accent-hover active:bg-th-accent/30 focus-visible:ring-th-accent/50";

	// The dense meta rows only leave ~20px of visible height, so the transparent
	// `before` pseudo-element expands the vertical hit target to WCAG's ≥44px.
	return (
		<Link
			to={to}
			params={params}
			search={search}
			className={`relative inline-flex min-w-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors before:absolute before:inset-x-0 before:-inset-y-[0.6875rem] before:content-[''] focus-visible:outline-none focus-visible:ring-2 ${variantClass} ${className ?? ""}`}
			title={displayName}
			aria-label={label}
		>
			<GitBranch className="size-3 shrink-0" aria-hidden="true" />
			<span className="truncate">{displayName}</span>
		</Link>
	);
}

export default WorktreeBadge;
