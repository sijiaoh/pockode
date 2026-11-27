import { Bot, ListChecks } from "lucide-react";
import { hasProcess, subagentNow } from "../../lib/subagentRun";
import { toolSummary } from "../../lib/toolSummary";
import type { AgentsOverview, PlanOverview } from "../../lib/turnOverview";
import { planLineLabel, planLineWords } from "../../lib/turnOverview";
import type { ToolRun } from "../../types/message";
import { CollapsibleBody } from "../ui";
import { BareBody, BareRow } from "./BareRow";
import {
	SUBAGENT_OPENER_ATTR,
	useOpenSubagentTranscript,
} from "./subagentTranscriptContext";
import { LatestChildLabel, subagentHeader } from "./TaskItem";
import { planTodos, TodoChecklist } from "./ToolInvocation";
import {
	RowButton,
	ToolRowFirstLine,
	ToolRowSecondLine,
	toolStatusWord,
} from "./ToolRow";
import { useGoToCall } from "./toolJumpContext";
import { useTurnTail } from "./turnTailContext";
import { useUnfiledChildren } from "./unfiledChildrenContext";

interface Props {
	/** The message this slot belongs to; the lines are drawn in one slot only. */
	messageId: string;
	className?: string;
}

const GLYPH = (
	<Bot aria-hidden className="mt-0.5 size-3 shrink-0 text-th-text-muted" />
);

const PLAN_GLYPH = (
	<ListChecks
		aria-hidden
		className="mt-0.5 size-3 shrink-0 text-th-text-muted"
	/>
);

/**
 * Where the open turn's plan stands, and its checklist in place
 * (docs/turn-progress-ui.md#42-the-plan-line). The count and the label never
 * give way; only the item does.
 */
function PlanLine({ plan }: { plan: PlanOverview }) {
	if (!plan.plan) return null;
	const { steps, explanation } = plan.plan;
	const words = planLineWords(steps);
	return (
		<>
			<BareRow
				glyph={PLAN_GLYPH}
				toggle={{
					expanded: plan.expanded,
					onToggle: plan.onToggle,
					label: planLineLabel(words),
				}}
			>
				<span aria-hidden className="flex items-baseline gap-1.5">
					<span className="shrink-0 text-th-text-secondary tabular-nums">
						{words.done}/{words.total}
					</span>
					<span className="shrink-0 text-th-text-muted">·</span>
					{words.label === "All done" ? (
						<span className="shrink-0 text-th-text-muted">All done</span>
					) : (
						<>
							<span className="shrink-0 text-th-text-muted">
								{words.label}:
							</span>
							<span className="min-w-0 truncate text-th-text-secondary">
								{words.item}
							</span>
							{words.more > 0 && (
								<span className="shrink-0 text-th-text-muted">
									+{words.more}
								</span>
							)}
						</>
					)}
				</span>
			</BareRow>
			<CollapsibleBody expanded={plan.expanded}>
				<BareBody>
					<div className="px-2.5 py-2">
						<TodoChecklist todos={planTodos(steps)} explanation={explanation} />
					</div>
				</BareBody>
			</CollapsibleBody>
		</>
	);
}

function agentsLabel(count: number): string {
	if (count === 0) return "No agents running";
	return count === 1 ? "1 agent running" : `${count} agents running`;
}

/**
 * The named agent and what it is doing now. Its own component because the
 * unfiled children are read by hook, per run.
 */
function NamedAgent({ run }: { run: ToolRun }) {
	const unfiled = useUnfiledChildren(run.id);
	const now = subagentNow(run, unfiled);
	const title = toolSummary(run.name, run.input, "").title;
	return (
		<>
			<span className="shrink-0 text-th-text-muted">·</span>
			{/* The title gives way only once the child has: nearly nothing to shrink
			    by against the child's whole width. */}
			<span className="min-w-0 shrink-[0.01] truncate text-th-text-secondary">
				{title}
			</span>
			{now && (
				<span className="flex min-w-0 items-baseline gap-1.5 text-th-text-muted">
					<LatestChildLabel child={now} />
				</span>
			)}
		</>
	);
}

/**
 * One subagent in the open list: its row's header, drawn again from the run.
 * A press opens the subagent's transcript, where its work is read whole — or,
 * for one with no work to show there (no ⤢ on its row either), goes to its row.
 */
function AgentEntry({ run }: { run: ToolRun }) {
	const unfiled = useUnfiledChildren(run.id);
	const openTranscript = useOpenSubagentTranscript();
	const goToCall = useGoToCall();
	const header = subagentHeader(run, unfiled);
	const toTranscript = openTranscript && hasProcess(run, unfiled);
	// Starting with the visible words (WCAG 2.5.3): the title, then the detail.
	const label = [
		header.summary.title,
		header.summary.detail + header.summary.detailTail,
		toolStatusWord(run.status),
		toTranscript ? "open its transcript" : "go to its row",
	]
		.filter(Boolean)
		.join(", ");
	return (
		<li>
			<RowButton
				expanded={false}
				toggleable={false}
				noLead
				onToggle={(event) =>
					toTranscript
						? openTranscript(run.id, event.currentTarget)
						: goToCall?.(run.id)
				}
				glyph={header.glyph}
				error={header.failed}
				label={label}
				// Focus comes back here when the transcript closes, or to the ⤢
				// standing for the same run if this entry has gone meanwhile.
				data={toTranscript ? { [SUBAGENT_OPENER_ATTR]: run.id } : undefined}
			>
				<span className="flex items-baseline gap-1.5">
					<ToolRowFirstLine {...header.firstLine} />
				</span>
				<ToolRowSecondLine {...header.secondLine} />
			</RowButton>
		</li>
	);
}

function AgentsLine({ agents }: { agents: AgentsOverview }) {
	// Outside a transcript there is nowhere to go, and the list is not drawn.
	const inTranscript = useGoToCall() !== null;
	return (
		<>
			<BareRow
				glyph={GLYPH}
				toggle={{
					expanded: agents.expanded,
					onToggle: agents.onToggle,
					label: agentsLabel(agents.liveCount),
				}}
			>
				{/* The named agent moves while it is live, so only the count names
				    the button (the second line's rule). */}
				<span aria-hidden className="flex items-baseline gap-1.5">
					<span className="shrink-0 text-th-text-secondary">
						{agentsLabel(agents.liveCount)}
					</span>
					{agents.named && <NamedAgent run={agents.named} />}
				</span>
			</BareRow>
			<CollapsibleBody expanded={agents.expanded}>
				{agents.entries.length > 0 && inTranscript && (
					<BareBody>
						<ul aria-label="Agents" className="divide-y divide-th-border">
							{agents.entries.map((run) => (
								<AgentEntry key={run.id} run={run} />
							))}
						</ul>
					</BareBody>
				)}
			</CollapsibleBody>
		</>
	);
}

/**
 * The lines under the tail line: the plan, then what is running
 * (docs/turn-progress-ui.md#4-what-is-running-and-the-plan). Drawn in the one
 * slot `overviewMessageId` names, read through the tail's context so a change
 * re-renders that slot and no other bubble. Each line comes and goes on its own
 * condition, never on the turn's phase.
 */
function TurnOverview({ messageId, className }: Props) {
	const { overviewMessageId, plan, agents } = useTurnTail();
	if (overviewMessageId !== messageId) return null;
	const showAgents = agents.liveCount > 0 || agents.expanded;
	if (!plan.plan && !showAgents) return null;
	return (
		<div className={`text-xs ${className ?? ""}`}>
			<PlanLine plan={plan} />
			{showAgents && <AgentsLine agents={agents} />}
		</div>
	);
}

export default TurnOverview;
