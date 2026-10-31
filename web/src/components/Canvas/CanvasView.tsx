import { useEffect, useRef } from "react";
import {
	canvasSizeOf,
	isEditableElement,
	keepsMeasurement,
} from "../../lib/canvasSize";
import {
	canvasActions,
	selectCanvasState,
	useCanvasStore,
} from "../../lib/canvasStore";
import type { CanvasActionInput } from "../../lib/rpc";
import { CanvasFrame, type CanvasSendBlock } from "./CanvasFrame";

interface Props {
	sessionId: string;
	/**
	 * Whether canvas view is the one on screen with nothing over it. False under
	 * chat view or an overlay: the frame stays mounted then, but is not measured
	 * — what it would measure is not the canvas area a canvas view has.
	 */
	shown: boolean;
	/**
	 * Whether the area is measured; `shown` when absent. False while something
	 * drawn over the canvas pushes the bars into it — the answer panel — so
	 * that height is not taken for the canvas's.
	 */
	measure?: boolean;
	/** The session's turn is running, which the empty canvas says. */
	turnRunning: boolean;
	/** `useChatMessages(...).sendCanvasAction`. */
	onSend: (input: CanvasActionInput) => Promise<void>;
	sendBlocked?: CanvasSendBlock | null;
}

/**
 * The canvas view's canvas (docs/canvas-ui.md §2): the session's current page,
 * filling the rectangle it is given, and the device's canvas size measured
 * from it (§5).
 *
 * One per session: key it by the session, as its frame records the revision
 * it shows and the page's focus for that session alone.
 *
 * The permission banner goes above the frame, inside this column, and the
 * activity strip below it, between this and the input (§10, §11).
 */
export function CanvasView({
	sessionId,
	shown,
	measure = shown,
	turnRunning,
	onSend,
	sendBlocked = null,
}: Props) {
	const canvas = useCanvasStore(selectCanvasState(sessionId));
	const areaRef = useRef<HTMLDivElement>(null);
	// Only the page can see its own focus; the bridge reports it.
	const pageEditable = useRef(false);

	// The area is the frame's, so it is there only once the frame is.
	const isFrameMounted = canvas !== null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `isFrameMounted` is when `areaRef` gets its element
	useEffect(() => {
		const area = areaRef.current;
		if (!measure || !area) return;
		// Read at each measurement rather than tracked: focus moves through
		// the composer, the page and anything else the app draws, and what
		// matters is only where it is when the area changes size.
		const editing = () => {
			const active = document.activeElement;
			if (active instanceof HTMLIFrameElement) {
				return area.contains(active) && pageEditable.current;
			}
			return isEditableElement(active);
		};
		const observer = new ResizeObserver(([entry]) => {
			// The content box, which leaves out the area's scrollbars: what a
			// page drawn for this size gets at 100%.
			const measured = canvasSizeOf(entry.contentRect);
			if (measured === null) return;
			const kept = useCanvasStore.getState().size;
			if (keepsMeasurement(kept, measured, editing())) {
				canvasActions.setSize(measured);
			}
		});
		observer.observe(area);
		return () => observer.disconnect();
	}, [measure, isFrameMounted]);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col bg-th-bg-primary">
			{canvas !== null && (
				<CanvasFrame
					sessionId={sessionId}
					canvas={canvas}
					onSend={onSend}
					sendBlocked={sendBlocked}
					onEditableFocus={(editable) => {
						pageEditable.current = editable;
					}}
					shown={shown}
					areaRef={areaRef}
					className="flex-1"
				/>
			)}
			{/* No spinner of its own: liveness is the activity strip's. */}
			{canvas?.revision === 0 && (
				<p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-th-text-muted">
					{turnRunning ? "The agent is drawing…" : "Nothing drawn yet"}
				</p>
			)}
		</div>
	);
}
