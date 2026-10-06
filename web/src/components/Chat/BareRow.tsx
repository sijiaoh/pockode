import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
	glyph: ReactNode;
	/** Present when the row opens a body; without it the row is not a button. */
	toggle?: { expanded: boolean; onToggle: () => void; label: string };
	/** The words, on one line; whatever in them may shrink must say so itself. */
	children: ReactNode;
}

// Fitted to its words rather than spanning the column: with no frame around
// it, a full-width hover would be a bar floating in the transcript. The 8px
// padding pushes the highlight out past the text and the negative margin pulls
// the glyph back onto the text's left edge — 8px because that is the narrowest
// gutter the row is drawn in, a subagent's Process, whose rule it must not
// cover. The touch floor is the height's job; the width follows the words.
const BOX =
	"-mx-2 flex min-h-9 w-fit max-w-[calc(100%+1rem)] flex-col justify-center rounded-md px-2 py-1.5 text-left pointer-coarse:min-h-11";

/**
 * A row drawn without a list's frame — the turn's tail line, and a thinking
 * with no call beside it (docs/turn-progress-ui.md#12-where-it-goes-and-groups):
 * the glyph on the text's left edge, where the settled turn's Copy button will
 * be, and the chevron after the words rather than in a column of its own,
 * since there are no rows around it to line up with.
 *
 * A static row keeps the same box, so a `Thinking…` that gains text and
 * becomes openable does not move by a pixel.
 */
export function BareRow({ glyph, toggle, children }: Props) {
	const line = (
		// `items-start`, not centred: the glyph's and the chevron's `mt-0.5` level
		// them with the first line of text.
		<span className="flex items-start gap-1.5">
			{glyph}
			<span className="min-w-0">{children}</span>
			{toggle && (
				<ChevronRight
					className={`mt-0.5 size-3 shrink-0 text-th-text-muted transition-transform ${toggle.expanded ? "rotate-90" : ""}`}
				/>
			)}
		</span>
	);
	if (!toggle) return <div className={BOX}>{line}</div>;
	return (
		<button
			type="button"
			onClick={toggle.onToggle}
			aria-expanded={toggle.expanded}
			aria-label={toggle.label}
			// Inset, so the ring stays inside the 8px the box borrows and off a
			// Process's rule.
			className={`${BOX} hover:bg-th-overlay-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset`}
		>
			{line}
		</button>
	);
}

/**
 * What a bare row opens: a box of its own under the row, edge to edge with the
 * column like a framed list. The tail line and the thinking it settles into
 * share it, so a body opened while `Thinking…` looks the same once it is
 * `Thought for 12s`.
 */
export function BareBody({ children }: { children: ReactNode }) {
	return (
		<div className="overflow-hidden rounded-lg border border-th-border bg-th-bg-secondary">
			{children}
		</div>
	);
}
