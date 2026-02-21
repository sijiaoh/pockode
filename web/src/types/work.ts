export type WorkType = "story" | "task";

export type WorkStatus = "open" | "in_progress" | "done" | "closed";

export interface Work {
	id: string;
	type: WorkType;
	parent_id?: string;
	title: string;
	body?: string;
	status: WorkStatus;
	session_id?: string;
	created_at: string;
	updated_at: string;
}

export interface WorkCreateParams {
	type: WorkType;
	parent_id?: string;
	title: string;
	body?: string;
}

export interface WorkUpdateParams {
	id: string;
	title?: string;
	body?: string;
	status?: Exclude<WorkStatus, "closed">;
}

export interface WorkListSubscribeResult {
	id: string;
	items: Work[];
}

export type WorkListChangedNotification =
	| { id: string; operation: "create" | "update"; work: Work }
	| { id: string; operation: "delete"; workId: string }
	| { id: string; operation: "sync"; works: Work[] };
