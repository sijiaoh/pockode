import type { ReactNode } from "react";

/**
 * The sticky heading over one group of a list's rows, with the group's count.
 * The scroll container it pins in must carry no vertical padding of its own,
 * or rows show through the strip above it (web/AGENTS.md, Tailwind).
 */
export default function ListGroupHeading({
	label,
	count,
	icon,
}: {
	label: string;
	count: number;
	/** A decorative glyph before the label. */
	icon?: ReactNode;
}) {
	return (
		// Above the rows rather than level with them: a row lifts its own
		// controls to `z-10`, and a Stop button sliding over the heading it is
		// scrolling under would be drawn on top of it at the same level.
		<h2 className="sticky top-0 z-20 flex min-h-[32px] items-center gap-2 bg-th-bg-primary px-3 text-xs font-medium text-th-text-muted">
			{icon}
			<span className="flex-1">{label}</span>
			<span className="rounded-full bg-th-bg-tertiary px-1.5 py-0.5 tabular-nums">
				{count}
			</span>
		</h2>
	);
}
