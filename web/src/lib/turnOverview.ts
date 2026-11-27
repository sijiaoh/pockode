import type {
	ContentPart,
	Message,
	PlanStep,
	ToolRun,
	ToolRunPlan,
	TurnPhase,
} from "../types/message";
import { openAssistantIndex } from "./messageReducer";
import { isLiveRun } from "./subagentRun";
import { isTaskTool } from "./toolSummary";

/**
 * What the status line's plan and agents read off the transcript
 * (docs/turn-progress-ui.md#4-what-is-running-and-the-plan). Everything here is
 * the reducer's live `ToolRun` state, never a record: whether a run is still
 * going is its `status`, the one value its row is drawn from.
 */

/**
 * Every top-level subagent run in the loaded transcript, in transcript order:
 * a part in a reply's own content with no `parentToolUseId`. A run filed under
 * another subagent, or left flat naming its parent, is a step of that parent's
 * (docs/turn-progress-ui.md#43-the-agents).
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
 * What the agents chip and the panel's agents section draw from
 * (docs/turn-progress-ui.md#43-the-agents). Held by `useAgentsOverview`
 * rather than by the line, because the line moves between bubbles and slots,
 * which remounts it.
 */
export interface AgentsOverview {
	/** How many top-level subagent runs are live. */
	liveCount: number;
	/** The one the line names: the last live one in transcript order. */
	named?: ToolRun;
	/**
	 * What the open panel lists, in transcript order: the live runs, and those
	 * that settled while it was open. Empty while it is closed.
	 */
	entries: ToolRun[];
}

/**
 * Whether the status line's one panel is open
 * (docs/turn-progress-ui.md#4-what-is-running-and-the-plan). Held beside the transcript for the
 * agents' reason: the line moves between bubbles and slots.
 */
export interface TurnPanel {
	expanded: boolean;
	onToggle: () => void;
}

/** The ids of the live ones among `runs`. */
export function liveIds(runs: ToolRun[]): string[] {
	return runs.filter(isLiveRun).map((run) => run.id);
}

/**
 * Whether a turn is open: the server says one is, or the open bubble is this
 * client's `sending` placeholder, which stands for the turn the send is about
 * to open before the server has said so (docs/lifecycle-ui.md §2.3). Located
 * by the open bubble rather than by the end of the list, because a second
 * message typed inside that same round trip is appended below it and would
 * otherwise cancel the optimism that message needs most.
 */
export function isTurnOpen(messages: Message[], phase: TurnPhase): boolean {
	if (phase !== "idle") return true;
	const openIndex = openAssistantIndex(messages);
	return openIndex >= 0 && messages[openIndex].status === "sending";
}

/**
 * The assistant message whose turn-end slot draws the plan and the agents: the
 * bubble the open turn is writing into; with none, the last assistant message
 * while `lingering` — an agent outlives the turn, or the panel the user opened
 * is still open — and otherwise none
 * (docs/turn-progress-ui.md#43-the-agents).
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
 * (docs/turn-progress-ui.md#42-the-plan).
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
 * The ids of the open turn's replies; none while no turn is open
 * (docs/tool-call-ui.md#settling-and-folding).
 */
export function openTurnReplyIds(
	messages: Message[],
	turnOpen: boolean,
): ReadonlySet<string> {
	if (!turnOpen) return new Set();
	return new Set(openTurnReplies(messages).map((reply) => reply.id));
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
 * (docs/turn-progress-ui.md#42-the-plan).
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
 * What the status line says of the plan, in parts: the count, then `Now:` the first item in
 * progress (and how many more are), `Next:` the first pending one, or that
 * every item is done (docs/turn-progress-ui.md#42-the-plan).
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

/** How many agents are live, as a phrase: `2 agents running`. */
export function agentsLabel(count: number): string {
	if (count === 0) return "No agents running";
	return count === 1 ? "1 agent running" : `${count} agents running`;
}

/**
 * The status line's name: only the facts that do not move while they are
 * live, never the free text — `Working, plan 3 of 7, 2 agents running,
 * details` (docs/turn-progress-ui.md#48-accessibility). Absent parts are left
 * out.
 */
export function statusLineLabel({
	phase,
	plan,
	agents,
}: {
	/** The phase label, without its ellipsis. */
	phase?: string;
	plan?: Pick<PlanLineWords, "done" | "total">;
	/** Live agents, when the line shows a count. */
	agents?: number;
}): string {
	const label = [
		phase,
		plan && `plan ${plan.done} of ${plan.total}`,
		agents !== undefined && agentsLabel(agents).toLowerCase(),
		"details",
	]
		.filter(Boolean)
		.join(", ");
	return label.charAt(0).toUpperCase() + label.slice(1);
}
