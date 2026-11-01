import { create } from "zustand";
import type { CanvasSize, CanvasState } from "../types/canvas";

interface CanvasStoreState {
	/** Which session `canvas` belongs to, or null when nothing is held. */
	sessionId: string | null;
	canvas: CanvasState | null;
	/**
	 * The device's canvas size: the last measurement canvas view kept
	 * (docs/canvas-ui.md §5). Every message sent to a canvas session carries
	 * it, from either view — chat view sends the last one canvas view
	 * measured, or none if it never showed. The device's, not a session's.
	 */
	size: CanvasSize | null;
	/**
	 * Counts what may have settled the open session's canvas calls — a tool
	 * result recorded, or a turn ending, which clears every call still in
	 * flight. Each may clear a history entry's `fork_blocked: "pending"`, which
	 * nothing pushes (docs/canvas-ui.md §13.5, §15.3); the history view reads
	 * its list again on a change. A count, not a state: what it says is only
	 * "ask again".
	 */
	callsSettled: number;
}

interface CanvasStoreActions {
	/**
	 * Takes a state the server pushed, from the subscribe reply or a
	 * `chat.canvas_state`, in whichever order they arrive. Each one is the
	 * whole state, so there is nothing to reconstruct: the highest revision
	 * wins, and an older one arriving late is dropped.
	 */
	receive: (sessionId: string, canvas: CanvasState) => void;
	/** Lets go of the session's canvas, if it is the one held. */
	forget: (sessionId: string) => void;
	setSize: (size: CanvasSize) => void;
	callSettled: () => void;
}

export type CanvasStore = CanvasStoreState & CanvasStoreActions;

/**
 * The open session's current canvas — state the canvas store on the server
 * owns and pushes through the chat subscription (docs/canvas-ui.md §13.2).
 *
 * One session at a time, as `sessionDetailStore` is: it is the canvas on
 * screen, and a page can be 256KB, so it is not a cache of every canvas
 * visited. Filled by `useChatMessages`, which holds that subscription.
 */
export const useCanvasStore = create<CanvasStore>((set, get) => ({
	sessionId: null,
	canvas: null,
	size: null,
	callsSettled: 0,
	receive: (sessionId, canvas) => {
		const held = get();
		if (
			held.sessionId === sessionId &&
			held.canvas &&
			held.canvas.revision >= canvas.revision
		) {
			return;
		}
		set({ sessionId, canvas });
	},
	forget: (sessionId) => {
		if (get().sessionId !== sessionId) return;
		set({ sessionId: null, canvas: null });
	},
	setSize: (size) => set({ size }),
	callSettled: () => set({ callsSettled: get().callsSettled + 1 }),
}));

/**
 * The session's current canvas, or null while none is known for it — before
 * the subscribe reply, for a session that is not a canvas session, and while
 * another session's canvas is the one held.
 */
export const selectCanvasState =
	(sessionId: string | null) =>
	(state: CanvasStore): CanvasState | null =>
		sessionId !== null && state.sessionId === sessionId ? state.canvas : null;

/** The session's current revision, or null while no canvas is known for it. */
export function useCanvasRevision(sessionId: string | null): number | null {
	return useCanvasStore(
		(state) => selectCanvasState(sessionId)(state)?.revision ?? null,
	);
}

/**
 * Whether the session has a page to look back from — what turns both entries
 * to the history view on (docs/canvas-ui.md §15.1). Not "has an earlier page":
 * gaps and forks mean only the list can say that, and with one page the view
 * opens on the current one.
 */
export function isCanvasDrawn(revision: number | null): boolean {
	return revision !== null && revision > 0;
}

/** What an entry to the history view says while `isCanvasDrawn` is false. */
export const NOTHING_DRAWN = "Nothing drawn yet";

export const canvasActions = {
	receive: (sessionId: string, canvas: CanvasState) =>
		useCanvasStore.getState().receive(sessionId, canvas),
	forget: (sessionId: string) => useCanvasStore.getState().forget(sessionId),
	setSize: (size: CanvasSize) => useCanvasStore.getState().setSize(size),
	callSettled: () => useCanvasStore.getState().callSettled(),
};
