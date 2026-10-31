// The client half of the canvas contract (docs/canvas-ui.md §6.2, §6.4, §13.2).

/** CSS pixels, whole numbers from 1 to 10000. */
export interface CanvasSize {
	width: number;
	height: number;
}

export type CanvasOp =
	| { op: "replace" | "append"; region: string; html: string }
	| { op: "remove"; region: string };

export type CanvasChange =
	| { kind: "render" }
	| { kind: "update"; from_revision: number; ops: CanvasOp[] };

/**
 * A canvas session's current canvas, as `chat.messages.subscribe` and
 * `chat.canvas_state` push it. State, not a record: the current page is never
 * looked for in the transcript, which may not even have that page loaded.
 */
export interface CanvasState {
	/** 0 = nothing drawn yet; the fields below are then absent. */
	revision: number;
	/** The whole document of this revision. */
	html?: string;
	/** Absent when no size had been reported when it was drawn. */
	drawn_for?: CanvasSize;
	/** How this revision came from the previous one. */
	change?: CanvasChange;
	/** RFC 3339. */
	drawn_at?: string;
}

/** `chat.canvas_state`'s params: `id` is the chat subscription's. */
export interface CanvasStateNotification {
	id: string;
	canvas: CanvasState;
}

/**
 * What the user did on a canvas page, as a user message record carries it —
 * the structured copy the chat view draws from; `content` is the agent's text.
 */
export interface CanvasAction {
	action: string;
	/** Any JSON; `{}` when the page sent none. */
	data: unknown;
	/** The revision the frame was showing when the user acted. */
	revision: number;
}

export interface CanvasActionParams {
	session_id: string;
	/** 1–128 characters, no control characters. */
	action: string;
	/** Any JSON; omitted = `{}`; at most 64KB serialized. */
	data?: unknown;
	revision: number;
	canvas_size?: CanvasSize;
}

/**
 * Why a fork from a page would be refused (docs/canvas-ui.md §13.5); absent on
 * an entry when it can be made.
 */
export type CanvasForkBlocked =
	| "pending"
	| "no_record"
	| "superseded"
	| "subagent";

/** One revision as `chat.canvas_history` lists it, without its document. */
export interface CanvasHistoryEntry {
	revision: number;
	change_kind: CanvasChange["kind"];
	drawn_for?: CanvasSize;
	/** RFC 3339. */
	drawn_at: string;
	/** The size of the revision's document. */
	bytes: number;
	fork_blocked?: CanvasForkBlocked;
}

/** One revision whole, as `chat.canvas_snapshot` answers: a state to draw. */
export interface CanvasSnapshot extends CanvasState {
	html: string;
	change: CanvasChange;
	drawn_at: string;
}
