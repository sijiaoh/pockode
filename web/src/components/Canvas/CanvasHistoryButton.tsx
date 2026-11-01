import { History } from "lucide-react";
import { isCanvasDrawn, NOTHING_DRAWN } from "../../lib/canvasStore";

/**
 * Canvas view's entry to its history view (docs/canvas-ui.md §15.1), leading
 * the collapsed input line. The line's own height, so the dock — and with it
 * the canvas area — keeps its size.
 *
 * Off by `aria-disabled` rather than `disabled`, so it stays focusable and its
 * name says why; and off only by the canvas, never by what blocks sending —
 * reading history sends nothing.
 */
export function CanvasHistoryButton({
	revision,
	onOpen,
}: {
	revision: number | null;
	onOpen: () => void;
}) {
	const drawn = isCanvasDrawn(revision);
	const label = drawn ? "Canvas history" : `Canvas history: ${NOTHING_DRAWN}`;
	return (
		<button
			type="button"
			onClick={drawn ? onOpen : undefined}
			aria-disabled={!drawn || undefined}
			aria-label={label}
			title={label}
			className={`flex size-9 shrink-0 items-center justify-center rounded-lg bg-th-bg-tertiary text-th-text-secondary pointer-coarse:size-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-border-focus ${
				drawn ? "hover:text-th-text-primary" : "cursor-not-allowed opacity-50"
			}`}
		>
			<History className="size-5" aria-hidden="true" />
		</button>
	);
}
