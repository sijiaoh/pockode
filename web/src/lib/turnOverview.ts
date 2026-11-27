import type {
	ContentPart,
	Message,
	PlanStep,
	ToolRun,
	ToolRunPlan,
} from "../types/message";
import { openAssistantIndex } from "./messageReducer";
import { isLiveRun } from "./subagentRun";
import { isTaskTool } from "./toolSummary";

/**
 * What the lines under the tail line read off the transcript
 * (docs/turn-progress-ui.md#4-what-is-running-and-the-plan). Everything here is
 * the reducer's live `ToolRun` state, never a record: whether a run is still
 * going is its `status`, the one value its row is drawn from.
 */

/**
 * Every top-level subagent run in the loaded transcript, in transcript order:
 * a part in a reply's own content with no `parentToolUseId`. A run filed under
 * another subagent, or left flat naming its parent, is a step of that parent's
 * (docs/turn-progress-ui.md#43-the-agents-line).
 */
export function topLevelAgentRuns(messages: Message[]): ToolRun[] {
	const runs: ToolRun[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.parts) {
			if (part.type !== "tool_call" || part.parentToolUseId) continue;
			if (isTaskTool(part.tool.name)) runs.push(part.tool);
		}
	}
	return runs;
}

/**
 * The runs a background wait is waiting on, in transcript order, of any tool:
 * every run in `background` status that is not filed under another one, which
 * stands for it (docs/turn-progress-ui.md#45-naming-what-a-background-wait-waits-on).
 * `held` are runs to keep whatever their status — the ones a list already
 * shows, which do not leave it under a press.
 */
export function backgroundTaskRuns(
	messages: Message[],
	held?: ReadonlySet<string>,
): ToolRun[] {
	const runs: ToolRun[] = [];
	const walk = (parts: ContentPart[], underBackground: boolean) => {
		for (const part of parts) {
			if (part.type !== "tool_call") continue;
			const run = part.tool;
			const background = run.status === "background";
			if ((background && !underBackground) || held?.has(run.id)) {
				runs.push(run);
			}
			if (run.children) walk(run.children, underBackground || background);
		}
	};
	for (const message of messages) {
		if (message.role === "assistant") walk(message.parts, false);
	}
	return runs;
}

/**
 * What the agents line draws from (docs/turn-progress-ui.md#43-the-agents-line).
 * Held by `useAgentsOverview` rather than by the line, because the line moves
 * between bubbles and slots, which remounts it.
 */
export interface AgentsOverview {
	/** How many top-level subagent runs are live. */
	liveCount: number;
	/** The one the line names: the last live one in transcript order. */
	named?: ToolRun;
	/**
	 * What the open list shows, in transcript order: the live runs, and those
	 * that settled while it was open. Empty while it is closed.
	 */
	entries: ToolRun[];
	expanded: boolean;
	onToggle: () => void;
}

/** The ids of the live ones among `runs`. */
export function liveIds(runs: ToolRun[]): string[] {
	return runs.filter(isLiveRun).map((run) => run.id);
}

/**
 * The assistant message whose turn-end slot draws the lines: the bubble the
 * open turn is writing into; with none, the last assistant message while
 * `lingering` — an agent outlives the turn, or the list the user opened is
 * still open — and otherwise none
 * (docs/turn-progress-ui.md#43-the-agents-line).
 */
export function overviewMessageId(
	messages: Message[],
	turnOpen: boolean,
	lingering: boolean,
): string | undefined {
	const openIndex = openAssistantIndex(messages);
	// The placeholder stands for the turn the send is about to open, before the
	// server has said so.
	if (
		openIndex >= 0 &&
		(turnOpen || messages[openIndex].status === "sending")
	) {
		return messages[openIndex].id;
	}
	if (!lingering) return undefined;
	return messages.findLast((m) => m.role === "assistant")?.id;
}

/**
 * The open turn's replies, newest first: the open bubble, and while the reply
 * just taken was opened by a read point, the reply before it — a read point
 * closes the bubble above it, and what that bubble holds is still this turn's
 * (docs/turn-progress-ui.md#42-the-plan-line).
 */
function openTurnReplies(messages: Message[]): Message[] {
	let index = openAssistantIndex(messages);
	const replies: Message[] = [];
	while (index >= 0) {
		const reply = messages[index];
		replies.push(reply);
		if (reply.role !== "assistant" || !reply.openedAtReadPoint) break;
		index = messages.findLastIndex(
			(m, i) => i < index && m.role === "assistant",
		);
	}
	return replies;
}

/**
 * The open turn's current plan: the newest main-agent plan by record order
 * among its replies' top-level runs, whichever CLI wrote it. A Claude
 * subagent's Task-tool calls write the session's one task list, and the
 * server files their record on the top-level subagent call, so they count
 * here as the main plan they are. A subagent resumed this turn is still filed
 * under the call that first spawned it, in an earlier turn's reply, so a
 * top-level run outside the open turn counts too, for a record newer than the
 * message that opened the turn. None while no turn is open, before the turn's
 * first plan, or when the newest one is empty — the agent cleared its list
 * (docs/turn-progress-ui.md#42-the-plan-line).
 */
export function currentPlan(
	messages: Message[],
	turnOpen: boolean,
): ToolRunPlan | undefined {
	if (!turnOpen) return undefined;
	const replies = openTurnReplies(messages);
	const oldest = replies.at(-1);
	const firstIndex = oldest ? messages.indexOf(oldest) : messages.length;
	// Without a seq on the turn's opening message there is no telling an
	// earlier reply's record from this turn's, and only the turn's own count.
	const since = messages
		.slice(0, firstIndex)
		.findLast((m) => m.role === "user")?.anchorSeq;
	const inTurn = new Set(replies);
	let newest: ToolRunPlan | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const floor = inTurn.has(message) ? Number.NEGATIVE_INFINITY : since;
		if (floor === undefined) continue;
		for (const part of message.parts) {
			if (part.type !== "tool_call" || part.parentToolUseId) continue;
			const plan = part.tool.plan;
			if (!plan || plan.order <= floor) continue;
			if (!newest || plan.order > newest.order) newest = plan;
		}
	}
	return newest && newest.steps.length > 0 ? newest : undefined;
}

/**
 * What the plan line says, in parts: the count, then `Now:` the first item in
 * progress (and how many more are), `Next:` the first pending one, or that
 * every item is done (docs/turn-progress-ui.md#42-the-plan-line).
 */
export interface PlanLineWords {
	done: number;
	total: number;
	label: "Now" | "Next" | "All done";
	/** The item's words; absent for `All done`. */
	item?: string;
	/** Items in progress beyond the one named. */
	more: number;
}

export function planLineWords(steps: PlanStep[]): PlanLineWords {
	const done = steps.filter((step) => step.status === "completed").length;
	const total = steps.length;
	const inProgress = steps.filter((step) => step.status === "in_progress");
	if (inProgress.length > 0) {
		const first = inProgress[0];
		return {
			done,
			total,
			label: "Now",
			item: first.activeText ?? first.text,
			more: inProgress.length - 1,
		};
	}
	const pending = steps.find((step) => step.status === "pending");
	if (pending) {
		return { done, total, label: "Next", item: pending.text, more: 0 };
	}
	return { done, total, label: "All done", more: 0 };
}

/**
 * The plan line's name, whole whatever the line truncates
 * (docs/turn-progress-ui.md#48-accessibility).
 */
export function planLineLabel(words: PlanLineWords): string {
	const count = `Plan, ${words.done} of ${words.total} done`;
	if (words.label === "All done") return `${count}, all done`;
	const more = words.more > 0 ? ` and ${words.more} more` : "";
	return `${count}, ${words.label.toLowerCase()} ${words.item}${more}`;
}

/**
 * What the plan line draws from. Held by `usePlanOverview` for the agents
 * line's reason: the line moves between bubbles, which remounts it.
 */
export interface PlanOverview {
	/** Absent when there is no line. */
	plan?: ToolRunPlan;
	expanded: boolean;
	onToggle: () => void;
}
