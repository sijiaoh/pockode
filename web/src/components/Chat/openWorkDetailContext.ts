import { createContext, useContext } from "react";

/**
 * Opens a work's detail overlay by id, for a row deep inside a bubble: a
 * Pockode work tool's body (`WorkRefLine`). Absent where there is no overlay
 * to open, and then the line offers no *Open*.
 */
export const OpenWorkDetailContext = createContext<
	((workId: string) => void) | undefined
>(undefined);

export function useOpenWorkDetail(): ((workId: string) => void) | undefined {
	return useContext(OpenWorkDetailContext);
}
