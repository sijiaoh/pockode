import type { ReactNode } from "react";

interface Props {
	label: string;
	/** L5 icon buttons for the group as a whole. */
	actions?: ReactNode;
}

/**
 * A label on the list, not a header for the page — that is the top bar's
 * job, and a group's label must not read like it.
 *
 * Sticky within the group it labels, so a long list keeps its count and its
 * actions reachable while it scrolls.
 */
function GroupHeader({ label, actions }: Props) {
	return (
		<div className="sticky top-0 z-10 flex min-h-[32px] items-center gap-2 bg-th-bg-secondary px-3 pointer-coarse:min-h-11">
			<span className="min-w-0 flex-1 truncate text-xs uppercase tracking-wide text-th-text-muted">
				{label}
			</span>
			{actions}
		</div>
	);
}

export default GroupHeader;
