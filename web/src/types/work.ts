export type WorkType = "story" | "task";

export type WorkStatus =
	| "open"
	| "in_progress"
	| "needs_input"
	| "stopped"
	| "done"
	| "closed";

export interface Work {
	id: string;
	type: WorkType;
	parent_id?: string;
	agent_role_id?: string;
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
	agent_role_id: string;
	title: string;
	body?: string;
}

export interface WorkUpdateParams {
	id: string;
	title?: string;
	body?: string;
	agent_role_id?: string;
}

export interface Comment {
	id: string;
	work_id: string;
	body: string;
	created_at: string;
}

export interface WorkListSubscribeResult {
	id: string;
	items: Work[];
}

export type WorkListChangedNotification =
	| { id: string; operation: "create" | "update"; work: Work }
	| { id: string; operation: "delete"; workId: string }
	| { id: string; operation: "sync"; works: Work[] };

export interface WorkDetailSubscribeResult {
	id: string;
	work: Work;
	comments: Comment[];
}

export interface WorkDetailChangedNotification {
	id: string;
	work: Work;
	comments: Comment[];
}
