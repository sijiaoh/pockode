import { useCoverPage, useIsPageCovered } from "@pockode/shared";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
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
import type { TranscriptPermission } from "../../lib/permissionRequestStore";
import type { CanvasActionInput } from "../../lib/rpc";
import type {
	MessageStatus,
	PermissionRequest,
	SessionTurn,
} from "../../types/message";
import type { PromptError } from "../Chat/MessageItem";
import type { PermissionChoice } from "../Chat/PermissionRequestItem";
import { CanvasFrame, type CanvasSendBlock } from "./CanvasFrame";
import { PermissionBanner, PermissionExpiryLine } from "./PermissionBanner";
import { PermissionPanel } from "./PermissionPanel";
import { usePermissionBatch } from "./usePermissionBatch";

/** What the canvas's permission panel needs from the session (§10). */
export interface CanvasPermissions {
	turn: SessionTurn;
	/** The session detail is loaded, so `turn` is the session's own. */
	turnKnown: boolean;
	/** The transcript's permission cards, where loaded, by request id. */
	transcript: ReadonlyMap<string, TranscriptPermission>;
	/** The last reply's status: whether it is still open, how it ended. */
	replyStatus?: MessageStatus;
	isCodex: boolean;
	/** The chat card's answer path. */
	onRespond: (request: PermissionRequest, choice: PermissionChoice) => void;
	promptError?: PromptError;
	onOpenFile?: (path: string) => void;
}

const NO_PERMISSIONS: CanvasPermissions = {
	turn: { phase: "idle", open: false, since: "" },
	turnKnown: false,
	transcript: new Map(),
	isCodex: false,
	onRespond: () => {},
};

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
	/**
	 * How much of the bottom of the canvas the composer floating over it
	 * covers (`ComposerDock`'s `onCover`): the page scrolls past it, and the
	 * canvas size does not change for it (§2, §5).
	 */
	covered?: number;
	/** The session's turn is running, which the empty canvas says. */
	turnRunning: boolean;
	/** `useChatMessages(...).sendCanvasAction`. */
	onSend: (input: CanvasActionInput) => Promise<void>;
	sendBlocked?: CanvasSendBlock | null;
	/** Absent, no permission is ever shown (a test of the frame alone). */
	permissions?: CanvasPermissions;
	/**
	 * The kind chooser, drawn in place of the empty canvas's line while the
	 * session has not started — whether or not a canvas state has arrived
	 * (docs/new-session-ui.md §3.5).
	 */
	kindChooser?: ReactNode;
}

/**
 * The canvas view's canvas (docs/canvas-ui.md §2): the session's current page,
 * filling the rectangle it is given, and the device's canvas size measured
 * from it (§5).
 *
 * One per session: key it by the session, as its frame records the revision
 * it shows and the page's focus for that session alone.
 *
 * It also holds the permission panel, its banner and the expiry line (§10),
 * drawn inside this column so the session screen around it does not change.
 */
export function CanvasView({
	sessionId,
	shown,
	measure = shown,
	covered = 0,
	turnRunning,
	onSend,
	sendBlocked = null,
	permissions,
	kindChooser,
}: Props) {
	const canvas = useCanvasStore(selectCanvasState(sessionId));
	const areaRef = useRef<HTMLDivElement>(null);
	const columnRef = useRef<HTMLDivElement>(null);
	// Only the page can see its own focus; the bridge reports it.
	const pageEditable = useRef(false);

	const { onRespond, promptError, onOpenFile, ...permissionState } =
		permissions ?? NO_PERMISSIONS;
	const batch = usePermissionBatch({ sessionId, shown, ...permissionState });
	const { up: panelUp, bannerUp } = batch;

	// Where focus goes as the panel comes and goes (§10.2). Opening by
	// itself, it takes focus only where the block took it away — the canvas,
	// now inert, or the composer, now collapsed; asked for by Show, always.
	// Put away, focus goes to the banner; gone because none is left, back to
	// the canvas, if it was in the panel.
	const showPressed = useRef(false);
	const collapsePressed = useRef(false);
	const focusWasInPanel = useRef(false);
	// Asked as the panel mounts, once the canvas under it is inert and the
	// composer collapsed.
	const panelTakesFocus = () => {
		if (showPressed.current) return true;
		const active = document.activeElement;
		return (
			active === null ||
			active === document.body ||
			(active instanceof HTMLElement && active.matches(":disabled")) ||
			(columnRef.current?.contains(active) ?? false)
		);
	};
	const bannerRef = useRef<HTMLButtonElement>(null);
	const wasUp = useRef(panelUp);
	useLayoutEffect(() => {
		if (wasUp.current === panelUp) return;
		wasUp.current = panelUp;
		if (panelUp) return;
		if (collapsePressed.current) bannerRef.current?.focus();
		else if (focusWasInPanel.current && shown && !bannerUp) {
			areaRef.current?.querySelector("iframe")?.focus();
		}
		collapsePressed.current = false;
		focusWasInPanel.current = false;
	}, [panelUp, bannerUp, shown]);
	// A Show is one press: read by the panel mounting in its commit — a
	// child's layout effect runs first — and forgotten after it, whether the
	// panel came up or another layer held it back.
	useLayoutEffect(() => {
		showPressed.current = false;
	});
	const collapse = batch.collapse;
	const collapseByUser = () => {
		collapsePressed.current = true;
		collapse();
	};
	// A layer, so Back collapses it (docs/project-ui.md §5.2). A navigation
	// takes its entry and leaves it as it is: the page drawn over the session
	// takes it off the screen, and coming back finds it as left (§10.2), with
	// an entry of its own again. Not before: an entry taken back while the
	// navigation is still landing could be pushed over the page it lands on.
	const [entryTaken, setEntryTaken] = useState(false);
	if (entryTaken && !panelUp) setEntryTaken(false);
	useCoverPage(panelUp && !entryTaken, {
		onBack: collapseByUser,
		onLeave: () => setEntryTaken(true),
	});
	// Without its entry the panel is not counted, so nothing keeps
	// `ChatPanel`'s interrupt — on `document`, before the panel's own
	// listener on `window` — from reading the same Escape as a Stop. Claimed
	// first, in the capture phase, unless a layer drawn over it is up.
	const pageCovered = useIsPageCovered();
	const uncounted = panelUp && entryTaken && !pageCovered;
	useEffect(() => {
		if (!uncounted) return;
		const claim = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			collapsePressed.current = true;
			collapse();
		};
		window.addEventListener("keydown", claim, true);
		return () => window.removeEventListener("keydown", claim, true);
	}, [uncounted, collapse]);
	const show = () => {
		showPressed.current = true;
		batch.show();
	};
	// The banner's height must not become the canvas size (§10.2). Read in
	// the observer as well: the effect that stops it runs after the browser
	// may already have reported the area the banner shrank.
	const measuring = measure && !bannerUp;
	const measuringRef = useRef(measuring);
	measuringRef.current = measuring;

	// The area is the frame's, so it is there only once the frame is.
	const isFrameMounted = canvas !== null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `isFrameMounted` is when `areaRef` gets its element
	useEffect(() => {
		const area = areaRef.current;
		if (!measuring || !area) return;
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
			// The content box: what a page drawn for this size gets at 100%.
			if (!measuringRef.current) return;
			const measured = canvasSizeOf(entry.contentRect);
			if (measured === null) return;
			const kept = useCanvasStore.getState().size;
			if (keepsMeasurement(kept, measured, editing())) {
				canvasActions.setSize(measured);
			}
		});
		observer.observe(area);
		return () => observer.disconnect();
	}, [measuring, isFrameMounted]);

	return (
		<div
			ref={columnRef}
			className="relative flex min-h-0 flex-1 flex-col bg-th-bg-primary"
		>
			{bannerUp ? (
				<PermissionBanner
					count={batch.bannerCount}
					oldest={batch.oldest}
					refused={batch.refused}
					attempt={batch.attempt}
					onShow={show}
					buttonRef={bannerRef}
				/>
			) : (
				batch.expiryText !== null && (
					<PermissionExpiryLine
						text={batch.expiryText}
						onDismiss={batch.dismissExpiry}
					/>
				)
			)}
			{/* The hosts strip and the frame, inert under the panel, which is
			    their sibling and so stays reachable. */}
			<div inert={panelUp} className="relative flex min-h-0 flex-1 flex-col">
				{canvas !== null && (
					<CanvasFrame
						sessionId={sessionId}
						canvas={canvas}
						onSend={onSend}
						sendBlocked={sendBlocked}
						onSendRefused={(code) => {
							if (code === "permission") batch.sendRefused();
						}}
						onEditableFocus={(editable) => {
							pageEditable.current = editable;
						}}
						shown={shown}
						covered={covered}
						areaRef={areaRef}
						className="flex-1"
					/>
				)}
				{/* No spinner of its own: liveness is the activity strip's. */}
				{kindChooser ? (
					// Scrolls rather than squeezing the block, as in chat view.
					<div className="absolute inset-0 flex flex-col overflow-y-auto">
						<div className="m-auto flex w-full flex-col items-center px-4 py-6">
							{kindChooser}
						</div>
					</div>
				) : (
					canvas?.revision === 0 && (
						<p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-th-text-muted">
							{turnRunning ? "The agent is drawing…" : "Nothing drawn yet"}
						</p>
					)
				)}
			</div>
			{batch.drawn && (
				<PermissionPanel
					active={panelUp}
					permissions={batch.permissions}
					isCodex={permissionState.isCodex}
					onRespond={onRespond}
					promptError={promptError}
					onOpenFile={onOpenFile}
					onCollapse={collapseByUser}
					takeFocus={panelTakesFocus}
					onUnmount={(hadFocus) => {
						focusWasInPanel.current = hadFocus;
					}}
					refused={batch.refused}
					attempt={batch.attempt}
				/>
			)}
		</div>
	);
}
