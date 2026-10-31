import { createContext, useContext } from "react";

/**
 * Opens the history view on a revision, for a canvas row's **Show**
 * (docs/canvas-ui.md §12, §15.1). Null where this client cannot read the
 * session's canvas — not a canvas session, or one read out of another
 * worktree — so its rows offer none.
 */
export type CanvasShow = (revision: number) => void;

export const CanvasShowContext = createContext<CanvasShow | null>(null);

export function useCanvasShow(): CanvasShow | null {
	return useContext(CanvasShowContext);
}
