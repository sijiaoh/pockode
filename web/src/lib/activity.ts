import {
	Circle,
	CircleCheck,
	CircleDot,
	CircleStop,
	Clock,
	Hourglass,
	Lock,
	type LucideIcon,
} from "lucide-react";
import type { SessionTurn } from "../types/message";
import type { WorkListItem, WorkStatus } from "../types/work";

/**
 * The only state any surface paints. Eight leaves, and there is never more than
 * one at a time: the layers it is derived from are each exclusive
 * (docs/lifecycle-ui.md §1.1).
 *
 * Nothing on screen may spell a state out of raw fields. A surface either
 * renders an `Activity` or it renders no state at all — which is what makes
 * this file the single place the derivation lives.
 */
export type Activity =
	| "open"
	| "running"
	| "needs_permission"
	| "background"
	| "waiting_children"
	| "idle"
	| "stopped"
	| "closed";

/** The five semantic hues an activity can wear. */
export type ActivityTone =
	| "accent"
	| "warning"
	| "secondary"
	| "muted"
	| "error";

interface ActivityView {
	Icon: LucideIcon;
	tone: ActivityTone;
	/**
	 * The state in words, for a surface with room to write it: the badge on the
	 * work detail, and the `aria-label` of a row that names its work in the same
	 * breath ("Fix the parser — Needs answer").
	 */
	label: string;
	/**
	 * What the glyph says when it stands alone, which is every surface that has
	 * no room for the label. It is a sentence rather than the label because a
	 * glyph on its own has to say who is waiting for whom — "Waiting for your
	 * answer", not "Needs answer".
	 */
	ariaLabel: string;
}

/**
 * One glyph and one tone per leaf.
 *
 * Three of these choices carry weight (docs/lifecycle-ui.md §1.1):
 * `running` and `idle` share `CircleDot` because they are the same thing — a
 * live, engine-driven work — differing only in whether a turn is open, so a
 * settling turn does not make a row appear to change identity. `background` is
 * deliberately quiet: there is nothing to do and nothing is stuck, and a louder
 * tone would re-create the two-hour spinner this redesign removes.
 * `waiting_children` keeps accent, because it is a structural state read on
 * purpose.
 *
 * `needs_permission` is the only leaf left in the warning hue, and it is the
 * whole of what an activity can say about the user being waited on. The other
 * dimension — questions waiting for an answer — is not an activity and is never
 * folded into one; see {@link needsAttention}.
 */
export const ACTIVITY_VIEW: Record<Activity, ActivityView> = {
	open: { Icon: Circle, tone: "muted", label: "Open", ariaLabel: "Open" },
	running: {
		Icon: CircleDot,
		tone: "accent",
		label: "Running",
		ariaLabel: "Agent is running",
	},
	needs_permission: {
		Icon: Lock,
		tone: "warning",
		label: "Needs permission",
		ariaLabel: "Waiting for your permission",
	},
	background: {
		Icon: Hourglass,
		tone: "secondary",
		label: "Background task",
		ariaLabel: "Waiting on a background task",
	},
	waiting_children: {
		Icon: Clock,
		tone: "accent",
		label: "Waiting on subtasks",
		ariaLabel: "Waiting on subtasks",
	},
	idle: { Icon: CircleDot, tone: "muted", label: "Idle", ariaLabel: "Idle" },
	stopped: {
		Icon: CircleStop,
		tone: "error",
		label: "Stopped",
		ariaLabel: "Stopped",
	},
	closed: {
		Icon: CircleCheck,
		tone: "muted",
		label: "Closed",
		ariaLabel: "Closed",
	},
};

/**
 * An activity as it arrived from the server, folded to one this build knows.
 *
 * Applied at the wire boundary, the way `normalizeOrigin` folds legacy message
 * origins: a client talking to a newer server must not blank a row over a leaf
 * it has never heard of, and `idle` is the leaf that claims the least.
 *
 * `Object.hasOwn` and not `in`: `in` walks the prototype chain, so `"toString"`
 * would pass for a leaf and then be looked up in the view map as a function —
 * a row rendering a glyph that does not exist. The one job of this function is
 * to not take the wire's word for it.
 */
export function normalizeActivity(raw: unknown): Activity {
	return typeof raw === "string" && Object.hasOwn(ACTIVITY_VIEW, raw)
		? (raw as Activity)
		: "idle";
}

/**
 * Whether the user is the one being waited on, across both dimensions: the one
 * activity leaf that waits on them, and the questions the session has posted and
 * nobody has answered (docs/lifecycle-ui.md §4).
 *
 * Two dimensions rather than one, because they are genuinely independent — an
 * agent that posts a question carries on running, so its activity says
 * `running` while the user still owes it an answer. Folding the question count
 * into the activity would make a running work claim to be idle.
 *
 * They are merged here and only here, for the surfaces that need a single bit:
 * the attention dot, the left edge of a row, the *Needs you* group. Anywhere a
 * user can act on one of the two, both are drawn side by side instead — a dot
 * cannot be aimed at, so it owes only the one bit.
 *
 * `background` and `waiting_children` are deliberately outside it: there is
 * nothing to do, and a dot meaning "something is happening" is a dot the user
 * learns to ignore.
 */
export function needsAttention(
	activity: Activity,
	unansweredQuestions = 0,
): boolean {
	return unansweredQuestions > 0 || activity === "needs_permission";
}

/**
 * What a client assumes before the server has said anything: no turn, and no
 * moment one started. `since` is empty rather than invented — it is only read
 * while blocked, which this never is, and a made-up timestamp would be shown.
 */
export const IDLE_TURN: SessionTurn = { phase: "idle", open: false, since: "" };

/** The part of a work this derivation reads. */
export type ActivityWork = Pick<WorkListItem, "status" | "wait">;

/**
 * Whether the engine is driving this work right now — which is the whole of
 * what `active` means. What it is waiting for while it does is `wait`, a
 * separate field, because the two are separate facts.
 */
export function isWorkActive(status: WorkStatus): boolean {
	return status === "active";
}

/**
 * The one rule (docs/lifecycle-ui.md §1.2):
 *
 * > The session says what is happening; the work's wait says what it is waiting
 * > for when nothing is happening.
 *
 * Why the phase outranks the wait rather than the other way round: a wait is a
 * standing intention, a phase is a fact about this second. An agent that calls
 * `work_wait` and then keeps writing for another ten seconds *is* running, and
 * the row should say so; the moment the turn settles the wait takes over. The
 * alternative needs a priority table between two kinds of waiting that
 * legitimately coexist, and every entry in such a table is an arbitrary choice
 * someone later "fixes".
 *
 * Permission outranks background when both are live: background is the one
 * nobody can act on, and those are the only two blockers a turn has.
 *
 * The server evaluates this same rule for work rows, which is where a row's
 * `activity` comes from (server/work/activity.go): a work list spans worktrees,
 * and a client cannot hold the turn state of a session in a worktree it has not
 * opened. The two implementations are checked against one shared table of cases,
 * `server/work/testdata/activity_cases.json`, so the rule is written down once.
 */
export function deriveActivity(
	work: ActivityWork | undefined,
	turn: SessionTurn | undefined,
): Activity {
	if (work) {
		if (work.status === "open") return "open";
		if (work.status === "closed") return "closed";
		if (work.status === "stopped") return "stopped";
	}

	if (turn?.phase === "running") return "running";
	if (turn?.phase === "blocked") {
		const kinds = turn.blockers?.map((blocker) => blocker.kind) ?? [];
		if (kinds.includes("permission")) return "needs_permission";
		return "background";
	}

	if (work?.wait === "child") return "waiting_children";
	return "idle";
}

/**
 * A session row's activity.
 *
 * The work is passed only while the engine is driving it, which is the subtle
 * call in this file: **a session row sees a work's wait, never its status.** The
 * wait is a fact about this conversation — the agent asked *here* for a message,
 * and the row is what tells the user that a session they are not looking at is
 * waiting on them. The status is not: a session outlives the work's lifecycle,
 * and a row reading `Stopped` or `Closed` would be reporting the work list's
 * business in a list that cannot act on it. Withholding the work unless it is
 * active makes those three leaves unreachable by construction.
 *
 * The caller looks the work up by the id its row carries, never by scanning for
 * a work that names the session: which sessions belong to work is the server's
 * answer now (docs/code/subscription-system.md#which-sessions-belong-to-work),
 * and the `wait` is the one thing a row still asks the work list for. So a work
 * the store has not paged in costs the row its `wait` and nothing else — it is
 * still in the right list and still says what its own turn is doing.
 */
export function sessionActivity(
	turn: SessionTurn | undefined,
	work: ActivityWork | undefined,
): Activity {
	return deriveActivity(
		work && isWorkActive(work.status) ? work : undefined,
		turn,
	);
}
