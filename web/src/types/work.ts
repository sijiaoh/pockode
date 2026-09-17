import type { Activity } from "../lib/activity";
import type { TokenUsage } from "./message";

export type WorkType = "story" | "task";

/**
 * What the engine is allowed to do with a work item, and nothing else:
 * `open` was never started, `active` is being driven, `stopped` waits for a
 * person, `closed` is finished.
 *
 * What the agent is *doing* is `Activity`, derived from this, the wait below and
 * the session's turn — see src/lib/activity.ts.
 */
export type WorkStatus = "open" | "active" | "stopped" | "closed";

/**
 * What an active work is waiting for, as its agent declared it. Absent means it
 * is waiting for nothing. Orthogonal to the status: a waiting work is still
 * being driven, it simply must not be nudged.
 */
export type WorkWait = "user" | "child";

/**
 * One row of the work list, as `work.list.subscribe` sends it: what drawing a
 * row needs, and nothing more. The whole item is `Work` below, and reaching it
 * means subscribing to `work.detail` for the one item you have open.
 *
 * What the row leaves out and why is docs/projects/api.md, *Work List Rows vs
 * Work Detail*. Before adding a field, note that several of the ones here are
 * not drawn on the row that carries them — `parent_id`, `status` and
 * `session_id` answer questions (the story/task tree, `isWorktreeBound`, which
 * sessions belong to work) that need the *whole* list to resolve one item, and
 * so have nowhere else to be answered from. "A row needs it" is that, not
 * "something on screen reads it".
 */
export interface WorkListItem {
	id: string;
	type: WorkType;
	parent_id?: string;
	agent_role_id?: string;
	title: string;
	status: WorkStatus;
	/**
	 * What the work is doing, computed by the server. The one thing on a row the
	 * client cannot derive itself: the list spans worktrees, and a client holds
	 * the turn state only of the worktree it has open
	 * (docs/lifecycle-ui.md §1.3). An unrecognised value normalises to `idle` at
	 * the wire boundary — an unknown state must not blank a row.
	 */
	activity: Activity;
	/** What an active work is waiting for; the agent's reason is on the detail. */
	wait?: WorkWait;
	session_id?: string;
	/** Worktree the work runs in (empty/undefined = main). Read-only, captured by backend. */
	worktree?: string;
	updated_at: string;
}

/**
 * A whole work item, as `work.detail.subscribe` reports it — and as
 * `work.create` / `work.start` answer, the two calls that speak for the single
 * item they acted on. Extending the row is what keeps the two in step: a field
 * added here stays out of the list until someone puts it there deliberately.
 *
 * `activity` is the one field of the row this is *not*: it is derived from the
 * turn of the work's session, which the stored record knows nothing about, so
 * it rides beside the item on the detail result the way usage does — and the
 * three calls answering with a bare item do not carry it at all.
 */
export interface Work extends Omit<WorkListItem, "activity"> {
	body?: string;
	current_step?: number;
	/**
	 * Why the agent is waiting, in its own words. Free text, shown verbatim on
	 * the detail page — it is the only place the user can read what the agent
	 * actually wants.
	 */
	wait_reason?: string;
	created_at: string;
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
	items: WorkListItem[];
}

export type WorkListChangedNotification =
	| { id: string; operation: "create" | "update"; work: WorkListItem }
	| { id: string; operation: "delete"; workId: string }
	| { id: string; operation: "sync"; works: WorkListItem[] };

/**
 * What a work item consumed, as the sessions beneath it reported it.
 *
 * It rides on the detail result and notification below, never on `Work`: usage
 * is computed by walking every session under the item, so a field there would
 * make every reader of a work item pay for that walk.
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
	 * column or two: only the detail carries usage, so the client has no
	 * consumption figure for any item but the one it has open.
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
	/** Derived like the row's, and on the detail for the same reason usage is. */
	activity: Activity;
}

export interface WorkDetailChangedNotification {
	id: string;
	work: Work;
	comments: Comment[];
	usage: WorkUsage;
	activity: Activity;
}
