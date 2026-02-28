export type OverlayState =
	| { type: "diff"; path: string; staged: boolean }
	| { type: "file"; path: string; edit?: boolean }
	| { type: "commit"; hash: string }
	| { type: "commit-diff"; hash: string; path: string }
	| { type: "settings" }
	| { type: "work-list" }
	| { type: "work-detail"; workId: string }
	| { type: "agent-role-list" }
	| { type: "agent-role-detail"; roleId: string }
	| null;
