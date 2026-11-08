import type { ResizableWidth } from "../../hooks/useResizableWidth";

interface Props {
	resize: ResizableWidth;
	/** Names the edge, e.g. "Resize sidebar". */
	label: string;
	/** Id of the column the handle resizes. */
	controls: string;
	onDoubleClick?: () => void;
}

/**
 * The right edge of a `relative` column sized by `useResizableWidth`.
 *
 * touch-pan-y, not touch-none: the handle claims horizontal drags only, so it
 * does not become an 8px strip that swallows scrolling.
 *
 * Deliberately left at 8px rather than widened to the 44px coarse floor. A
 * column's width is a preference, not an operation (P2 in
 * docs/responsive-ui.md), and a 44px drag strip would lie over the right edge
 * of every row in the column — where row actions such as Delete sit — turning
 * taps that work today into drags. The floor is there to make operations
 * reachable, not to make a preference easier at the cost of one.
 *
 * A focusable separator so a screen reader announces it as the column's
 * adjustable edge and a keyboard can move it. The focus ring is the accent
 * line hover already uses: an outline around an 8px strip would sit over the
 * column's own border.
 */
function ResizeHandle({ resize, label, controls, onDoubleClick }: Props) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: an <hr> is a static rule; a focusable, valued separator is a widget and has no element
		<div
			role="separator"
			aria-label={label}
			aria-orientation="vertical"
			aria-controls={controls}
			aria-valuenow={resize.width}
			aria-valuemin={resize.min}
			aria-valuemax={resize.max}
			aria-valuetext={`${resize.width} pixels`}
			tabIndex={0}
			{...resize.handlers}
			onDoubleClick={onDoubleClick}
			className="group absolute top-0 right-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize touch-pan-y outline-none"
		>
			<div
				className={`absolute left-1/2 h-full w-0.5 -translate-x-1/2 transition-colors group-hover:bg-th-accent group-focus-visible:bg-th-accent ${resize.isDragging ? "bg-th-accent" : "bg-transparent"}`}
			/>
		</div>
	);
}

export default ResizeHandle;
