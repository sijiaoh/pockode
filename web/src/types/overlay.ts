export type OverlayState =
	| { type: "diff"; path: string; staged: boolean }
	| { type: "file"; path: string; edit?: boolean }
	| { type: "commit"; hash: string }
	| { type: "commit-diff"; hash: string; path: string }
	| { type: "settings" }
	| { type: "tickets" }
	| { type: "agent-roles" }
	| null;
