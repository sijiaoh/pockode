/**
 * Overlay state for views that appear above the chat.
 * null = show chat, otherwise show the specified overlay.
 */
export type OverlayState =
	| { type: "diff"; path: string; staged: boolean }
	// Future: | { type: "file"; path: string }
	| null;
