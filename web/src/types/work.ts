import type { Activity } from "../lib/activity";
import type { PendingQuestion, TokenUsage } from "./message";

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
 *
 * One value, because there is one thing an agent can declare a wait on. It used
 * to be two: a wait on the *user* was `work_needs_input`, and it is gone — a
 * question an agent asks is now a question on the session's own unanswered list
 * (`unanswered_questions`), which is state the user can act on rather than a
 * sentence on a detail page.
 */
export type WorkWait = "child";

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
	/**
	 * How many questions this work's session is waiting on an answer to — the
	 * second dimension a row paints beside its activity (docs/project-ui.md §3,
	 * slot 2b). Only ever non-zero while the work is `active` or `stopped`:
	 * closing a work withdraws its questions, and an `open` one has no session.
	 * Absent means none.
	 */
	unanswered_questions?: number;
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

/**
 * The `Current` segment of the project list: every row it draws plus everything
 * those rows make claims about — a story's tasks for its `{closed}/{total}`, a
 * task's story for its `in: <title>` — and nothing closed. The archive is
 * fetched a page at a time (`work.list.archive`).
 *
 * `Current` itself is never paged: its group counts and the Project tab's
 * attention dot are read off it, and an "is there any" asked of a page answers
 * no for a list nobody has read that far (docs/list-paging-ui.md §2.1, §4.1).
 */
export interface WorkListSubscribeResult {
	items: WorkListItem[];
	/**
	 * How many rows of the *Stopped* and *Not running* groups the server held
	 * back. Each group's heading adds its own to the rows it received, so the
	 * count it shows stays that whole group's; absent or zero means that group
	 * arrived whole. One number per group, because one number spanning two
	 * headings would make at least one of them wrong.
	 */
	stopped_hidden?: number;
	open_hidden?: number;
}

/** One page of the archive, and the cursor that reaches the page after it. */
export interface WorkListArchiveResult {
	items: WorkListItem[];
	/** Opaque — handed back to the server unread. */
	next_cursor?: string;
	has_more?: boolean;
}

/** The `Current` segment with both group caps lifted, replacing it. */
export interface WorkListEarlierResult {
	items: WorkListItem[];
}

export type WorkListChangedNotification =
	| { id: string; operation: "create" | "update"; work: WorkListItem }
	| { id: string; operation: "delete"; workId: string }
	| {
			id: string;
			operation: "sync";
			works: WorkListItem[];
			stopped_hidden?: number;
			open_hidden?: number;
	  };

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
	/**
	 * The questions this work's session has asked and nobody has answered,
	 * oldest first. The list rather than a count, because the detail is the one
	 * surface with room to show what is being asked (docs/answering-ui.md §1).
	 */
	pending_questions?: PendingQuestion[];
	/**
	 * Every task under this item, and the story above it.
	 *
	 * They come with the detail rather than being looked up in the work list,
	 * because that list is the `Current` segment and holds no closed work: a
	 * closed story opened from the archive — or reloaded on — would otherwise
	 * look childless (docs/list-paging-ui.md §2.2).
	 */
	children: WorkListItem[];
	parent?: WorkListItem;
}

export interface WorkDetailChangedNotification {
	id: string;
	work: Work;
	comments: Comment[];
	usage: WorkUsage;
	activity: Activity;
	/** The same field, and the same rule, as on the subscribe result. */
	pending_questions?: PendingQuestion[];
	children: WorkListItem[];
	parent?: WorkListItem;
}
