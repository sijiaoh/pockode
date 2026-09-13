import type { TokenUsage } from "./message";

export type WorkType = "story" | "task";

export type WorkStatus =
	| "open"
	| "in_progress"
	| "waiting"
	| "needs_input"
	| "stopped"
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
	/** Worktree the work runs in (empty/undefined = main). Read-only, captured by backend. */
	worktree?: string;
	current_step?: number;
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

export interface CommentUpdateParams {
	id: string;
	body: string;
}

export interface Comment {
	id: string;
	work_id: string;
	body: string;
	created_at: string;
}

export interface WorkListSubscribeResult {
	items: Work[];
}

export type WorkListChangedNotification =
	| { id: string; operation: "create" | "update"; work: Work }
	| { id: string; operation: "delete"; workId: string }
	| { id: string; operation: "sync"; works: Work[] };

/**
 * What a work item consumed, as the sessions beneath it reported it.
 *
 * It rides on the detail result and notification below, never on `Work`: `Work`
 * is the one shape the list and the detail share, so a field here would ship a
 * subtree aggregation to every row of the work list.
 *
 * No context window at any level — a window belongs to one live conversation,
 * and the sum of several means nothing.
 */
export interface WorkUsage {
	/** This item's own session. Absent when it has none, or it reported nothing. */
	own?: TokenUsage;
	/** This item plus every descendant, at any depth. Absent under the same condition. */
	total?: TokenUsage;
	/**
	 * Descendants counted into `total`, at any depth; 0 when there are none.
	 * Always sent, and the only thing that decides whether the page shows one
	 * column or two: `Work` carries no usage, so the client has no consumption
	 * figure for any item but the one it has open.
	 */
	descendant_count: number;
	/**
	 * Sessions inside `total` that spent tokens while their agent reported no
	 * price. Non-zero makes the total cost a floor, and the UI says so.
	 */
	unpriced_session_count?: number;
}

export interface WorkDetailSubscribeResult {
	work: Work;
	comments: Comment[];
	usage: WorkUsage;
}

export interface WorkDetailChangedNotification {
	id: string;
	work: Work;
	comments: Comment[];
	usage: WorkUsage;
}
