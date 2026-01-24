export type OverlayState =
	| { type: "diff"; path: string; staged: boolean }
	| { type: "file"; path: string }
	| { type: "settings" }
	| null;
