import { Link } from "@tanstack/react-router";
import { Archive, GitBranch } from "lucide-react";
import { useWorktreeDisplay } from "../../hooks/useWorktreeDisplay";
import { useWorktreeList } from "../../hooks/useWorktreeList";
import { buildNavigation } from "../../lib/navigation";
import { isWorktreeBound, useWorkStore } from "../../lib/workStore";
import { useIsGitRepo } from "../../lib/worktreeStore";
import type { WorkListItem } from "../../types/work";

/** What the badge reads off a work: its worktree, and whether that is settled. */
export type WorktreeBadgeWork = Pick<
	WorkListItem,
	"id" | "story_id" | "status" | "worktree"
>;

interface Props {
	/** The work whose worktree assignment is shown. */
	work: WorktreeBadgeWork;
	/** Extra classes for layout, e.g. `max-w-*` in dense list rows. */
	className?: string;
}

/**
 * Whether the badge renders anything at all for this work.
 *
 * Exported because a meta line that separates its parts has to know which parts
 * there are before it draws the separators, and a caller re-deriving these two
 * conditions is a caller that drifts from them.
 */
export function useWorktreeBadgeVisible(work: WorktreeBadgeWork): boolean {
	const isGitRepo = useIsGitRepo();
	const { isMain } = useWorktreeDisplay(work.worktree);
	const isBound = useWorkStore((s) => isWorktreeBound(s.works, work));

	// A worktree that the backend can still rewrite would be misleading to show,
	// so an undecided binding renders nothing rather than a provisional name.
	if (!isBound) return false;

	// Non-git projects have no worktree concept, so the main badge is just noise.
	return !(isMain && !isGitRepo);
}

function WorktreeBadge({ work, className }: Props) {
	const { worktree } = work;
	const { displayName, isMain } = useWorktreeDisplay(worktree);
	const visible = useWorktreeBadgeVisible(work);
	const worktrees = useWorktreeList();

	if (!visible) return null;

	// Deleting a worktree leaves its sessions behind, so a work can outlive the
	// worktree it names. An empty list is one that has not landed rather than a
	// machine with no worktrees — the same reading AppShell's redirect guard
	// takes.
	const isGone =
		!isMain &&
		worktrees.length > 0 &&
		!worktrees.some((w) => w.name === worktree);

	if (isGone) {
		// A name, not a link: there is nowhere to go. And `Archive` rather than an
		// error colour — a deleted worktree is unusual, not a failure
		// (docs/sidebar-ui.md).
		return (
			<span
				className={`inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-th-text-muted ${className ?? ""}`}
				title={displayName}
			>
				<Archive className="size-3 shrink-0" aria-hidden="true" />
				<span className="truncate">{displayName}</span>
				<span className="sr-only">, deleted worktree</span>
			</span>
		);
	}

	const label = isMain ? "Open main worktree" : `Open worktree ${displayName}`;

	// Jump to the worktree root (no work/chat context); `replace` is ignored so
	// the navigation pushes a history entry.
	const { to, params, search } = buildNavigation({
		type: "home",
		worktree: worktree ?? "",
	});

	// Accent lettering on an accent tint fails AA in the light variants at every
	// opacity, so the label is the primary text colour and the hue moves to the
	// icon, which only owes the non-text floor. The icon holds that floor up to
	// /20 and not beyond, which is why the press state reuses the hover tint and
	// answers with scale instead of going darker.
	const variantClass = isMain
		? "text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-secondary active:bg-th-bg-tertiary focus-visible:ring-th-border-focus"
		: "bg-th-accent/10 text-th-text-primary hover:bg-th-accent/20 active:bg-th-accent/20 active:scale-95 focus-visible:ring-th-accent/50";

	// The dense meta rows only leave ~20px of visible height, so the transparent
	// `before` pseudo-element expands the vertical hit target to WCAG's ≥44px.
	// It is absolutely positioned inside this element, so a caller that clips —
	// `WorkRow`'s meta line does, to truncate its slots from the right — gets the
	// box height and not the 44. That is the caller's call to make: the reach
	// leaves this element's own box, and only the caller knows what it lands on
	// (docs/responsive-ui.md, blind spot 9).
	return (
		<Link
			to={to}
			params={params}
			search={search}
			className={`relative inline-flex min-w-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors before:absolute before:inset-x-0 before:-inset-y-[0.6875rem] before:content-[''] focus-visible:outline-none focus-visible:ring-2 ${variantClass} ${className ?? ""}`}
			title={displayName}
			aria-label={label}
		>
			<GitBranch
				className={`size-3 shrink-0 ${isMain ? "" : "text-th-accent"}`}
				aria-hidden="true"
			/>
			<span className="truncate">{displayName}</span>
		</Link>
	);
}

export default WorktreeBadge;
