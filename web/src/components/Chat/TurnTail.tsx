import { Bot, CircleDot, ListChecks } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useElapsedMs } from "../../hooks/useElapsedMs";
import { ACTIVITY_VIEW } from "../../lib/activity";
import { hasProcess, subagentNow } from "../../lib/subagentRun";
import { hasText, type LiveThinking, latestLine } from "../../lib/thinking";
import { formatElapsed } from "../../lib/toolRun";
import { toolSummary } from "../../lib/toolSummary";
import {
	type AgentsOverview,
	agentsLabel,
	type PlanLineWords,
	planLineWords,
	statusLineLabel,
	type TurnPanel,
} from "../../lib/turnOverview";
import type { AwaitedFetch, ToolRun, ToolRunPlan } from "../../types/message";
import { CollapsibleBody, Spinner } from "../ui";
import { BareBody, BareRow } from "./BareRow";
import { GoToCallButton } from "./GoToCallButton";
import MessageActions, { type MessageActionsProps } from "./MessageActions";
import {
	SUBAGENT_OPENER_ATTR,
	useOpenSubagentTranscript,
} from "./subagentTranscriptContext";
import { LatestChildLabel, subagentHeader } from "./TaskItem";
import { THOUGHT_BODY, ThoughtBody } from "./ThinkingItem";
import { planTodos, TodoChecklist } from "./ToolInvocation";
import {
	RowButton,
	ToolRowFirstLine,
	ToolRowSecondLine,
	toolStatusWord,
} from "./ToolRow";
import { useGoToCall } from "./toolJumpContext";
import { useOverviewTail, useTurnTail } from "./turnTailContext";
import { useUnfiledChildren } from "./unfiledChildrenContext";

interface Props {
	/** The message this slot belongs to; the plan and the agents are drawn in one slot only. */
	messageId: string;
	/**
	 * This bubble is the one the open turn is writing into. A bubble still
	 * streaming that the turn has moved on from keeps the slot and draws nothing.
	 */
	writing: boolean;
	/**
	 * The bubble is this client's optimistic placeholder, which the server has
	 * not said anything about yet: the line stands for the turn the send is
	 * about to open.
	 */
	placeholder: boolean;
	/**
	 * The main agent's newest call is a fetch filed under another row, still
	 * running: the line says the turn is waiting, and offers that row.
	 */
	awaitedFetch?: AwaitedFetch;
}

const ANNOUNCE_DELAY_MS = 100;

// Wrapped because `Spinner` is a status of its own, and one nested beside the
// line's would be announced too. Still under reduced motion: the words and the
// clock already say the turn is alive, and `Spinner` does not stop itself.
const GLYPH = (
	<span
		aria-hidden
		className="mt-0.5 flex size-3 shrink-0 items-center justify-center text-th-accent"
	>
		<Spinner
			variant="current"
			size="h-3 w-3"
			className="motion-reduce:hidden"
			srText={null}
		/>
		<CircleDot className="hidden size-3 motion-reduce:block" />
	</span>
);

const CHIP_ICON = "size-3 shrink-0 text-th-text-muted";

/**
 * How long the turn has been open. Its own component, so the shared tick
 * re-renders the clock and not the line.
 */
function TurnClock({ openedAt }: { openedAt: number }) {
	const elapsed = useElapsedMs(openedAt);
	// Not before three seconds, like a tool row's, so a turn that is over at once
	// never flashes a number.
	if (elapsed < 3000) return null;
	return (
		<span className="shrink-0 text-th-text-muted tabular-nums">
			{formatElapsed(elapsed)}
		</span>
	);
}

/** A count that never gives way, behind its own icon: `☑ 3/7`, `⧉ 2`. */
function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
	return (
		<span className="flex shrink-0 items-center gap-1 text-th-text-secondary tabular-nums">
			{icon}
			{children}
		</span>
	);
}

function PlanWords({ words }: { words: PlanLineWords }) {
	if (words.label === "All done") {
		return <span className="shrink-0">All done</span>;
	}
	return (
		<>
			<span className="shrink-0">{words.label}:</span>
			<span className="min-w-0 truncate">{words.item}</span>
			{words.more > 0 && <span className="shrink-0">+{words.more}</span>}
		</>
	);
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
			{/* The title gives way only once the child has: the child takes only
			    what the title leaves (`FreeText` says why not a tiny shrink). */}
			<span className="min-w-0 truncate">{title}</span>
			{now && (
				<span className="flex min-w-0 grow basis-0 items-baseline gap-1.5 overflow-hidden">
					<LatestChildLabel child={now} />
				</span>
			)}
		</>
	);
}

const DOT = <span className="shrink-0 text-th-text-muted">·</span>;

/**
 * The line's words: its segments in order, each behind a muted `·` that goes
 * with it when it is absent. The free text is last and gives way first, then
 * the phase label; the clock and the chips never do. The free text is never
 * first (each of its sources brings a segment before it) and carries its own
 * `·`, so the dot is clipped with it rather than left dangling.
 */
type Segments = [key: string, segment: ReactNode][];

const FREE = "free";

function StatusWords({ segments }: { segments: Segments }) {
	const present = segments.filter(([, segment]) => segment);
	return (
		<span aria-hidden className="flex items-center gap-1.5">
			{present.map(([key, segment], index) => (
				<Fragment key={key}>
					{index > 0 && key !== FREE && DOT}
					{segment}
				</Fragment>
			))}
		</span>
	);
}

/**
 * The free text, clipped as a whole once its own truncation is spent. A zero
 * basis that grows into whatever is left: so it is what gives way first, and
 * the label only shrinks once there is nothing left to give. A near-zero
 * `flex-shrink` on the label cannot say that: once the free text is spent, the
 * label's would be the only factor left, and a sum under 1 hands out only that
 * fraction of the overflow — the rest spills over the counts.
 */
function FreeText({ children }: { children: ReactNode }) {
	return (
		<span className="flex min-w-0 grow basis-0 items-center gap-1.5 overflow-hidden text-th-text-muted">
			{DOT}
			{children}
		</span>
	);
}

/**
 * The line's box: a toggle while the panel has a section, the same box static
 * otherwise, so gaining or losing the toggle moves nothing. A `Go to call`
 * stands beside it rather than in it, since a button cannot hold a button.
 */
function StatusRow({
	glyph,
	toggle,
	jump,
	children,
}: {
	glyph: ReactNode;
	toggle?: { expanded: boolean; onToggle: () => void; label: string };
	jump?: ReactNode;
	children: ReactNode;
}) {
	const row = (
		<BareRow glyph={glyph} toggle={toggle}>
			{children}
		</BareRow>
	);
	if (!jump) return row;
	// The gap clears the 8px the row's box borrows on its right.
	return (
		<div className="flex items-center gap-2.5">
			<div className="min-w-0">{row}</div>
			{jump}
		</div>
	);
}

/**
 * One subagent in the panel: its row's header, drawn again from the run. A
 * press opens the subagent's transcript, where its work is read whole — or,
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

function SectionHeading({ children }: { children: ReactNode }) {
	return (
		<p className="px-2.5 pt-2 pb-1 text-th-text-muted text-xs">{children}</p>
	);
}

/**
 * What the line opens: one box, a section per thing the line counts — the
 * plan, the agents, then the thinking so far. Thinking is last because it
 * comes and goes around nearly every codex call, and at the bottom that moves
 * nothing but what is under the panel.
 */
function Panel({
	plan,
	agents,
	thinking,
}: {
	plan?: ToolRunPlan;
	agents?: AgentsOverview;
	thinking?: LiveThinking | null;
}) {
	// Outside a transcript there is nowhere to go, and the list is not drawn.
	const inTranscript = useGoToCall() !== null;
	const words = plan && planLineWords(plan.steps);
	return (
		<BareBody>
			<div className="divide-y divide-th-border">
				{plan && words && (
					<div>
						<SectionHeading>
							Plan · {words.done}/{words.total}
						</SectionHeading>
						<div className="px-2.5 pb-2">
							<TodoChecklist
								todos={planTodos(plan.steps)}
								explanation={plan.explanation}
							/>
						</div>
					</div>
				)}
				{agents && (
					<div>
						<SectionHeading>
							Agents ·{" "}
							{agents.liveCount === 0
								? "none running"
								: `${agents.liveCount} running`}
						</SectionHeading>
						{agents.entries.length > 0 && inTranscript && (
							<ul
								aria-label="Agents"
								className="divide-y divide-th-border border-th-border border-t"
							>
								{agents.entries.map((run) => (
									<AgentEntry key={run.id} run={run} />
								))}
							</ul>
						)}
					</div>
				)}
				{thinking && (
					<div>
						<SectionHeading>Thinking so far</SectionHeading>
						<div className={`px-2.5 pb-2 ${THOUGHT_BODY}`}>
							{thinking.joinedLate && (
								<p className="mb-2 text-th-text-muted">
									Earlier thinking appears in full when it finishes.
								</p>
							)}
							<ThoughtBody thought={{ ...thinking, redacted: false }} live />
						</div>
					</div>
				)}
			</div>
		</BareBody>
	);
}

/**
 * The turn-end slot of the reply being written, while it is still being
 * written: one status line (docs/turn-progress-ui.md#2-the-tail-line) —
 * `⟳ Working 3m 17s · ☑ 3/7 · ⧉ 2 · Now: Writing the retry tests ›` — and the
 * one panel it opens (§4.1 there).
 *
 * The slot holds one line's height in every phase of the open turn, whatever
 * the line shows or whether it shows at all, so a turn blocking and resuming,
 * a plan arriving or an agent starting moves nothing, and settling swaps the
 * line for the turn-end row in place.
 */
function TurnTail({ messageId, writing, placeholder, awaitedFetch }: Props) {
	const tail = useTurnTail();
	const { phase, openedAt, thinking, panel } = tail;
	// A live region inserted with its text already in it is often not read out,
	// and the commonest way the line appears is with a new bubble — a send to an
	// idle agent. So the region goes in empty and is filled a moment later: on a
	// timer, because a send is a discrete update whose effects React runs in the
	// same task, before the accessibility tree has seen the empty region.
	const [announceable, setAnnounceable] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setAnnounceable(true), ANNOUNCE_DELAY_MS);
		return () => clearTimeout(timer);
	}, []);
	const goToCall = useGoToCall();

	// A blocked turn is not producing, and the attention strip says what it is
	// waiting on; the placeholder only speaks until the server does.
	const shown =
		writing && (phase === "running" || (placeholder && phase === "idle"));
	const live = shown && phase === "running" ? thinking : null;
	const thinkingText = live && hasText(live) ? live : null;
	// Thinking that has started is newer than the fetch it followed.
	const waiting =
		shown && phase === "running" && !live ? awaitedFetch : undefined;
	const label = !shown
		? undefined
		: live
			? "Thinking…"
			: waiting
				? waiting.waits
					? "Waiting for output…"
					: "Reading output…"
				: "Working";

	const overview = tail.overviewMessageId === messageId;
	const plan = overview ? tail.plan : undefined;
	const agents = overview ? tail.agents : undefined;
	const words = plan && planLineWords(plan.steps);
	const agentsSection =
		agents && (agents.liveCount > 0 || agents.entries.length > 0)
			? agents
			: undefined;
	const toggleable = Boolean(plan || agentsSection || thinkingText);

	// Exactly one source, the first that has something. The plan outranks the
	// thinking: codex switches between the two around nearly every call, and a
	// thinking line on top would flip the words several times a minute.
	const latest = thinkingText
		? latestLine(thinkingText.content || thinkingText.fullReasoning)
		: "";
	const free = words ? (
		<PlanWords words={words} />
	) : latest ? (
		<span className="min-w-0 truncate">{latest}</span>
	) : agentsSection?.named ? (
		<NamedAgent run={agentsSection.named} />
	) : null;

	const segments: Segments = [
		// The clock follows the word rather than the free text: that changes
		// length several times a second and would drag the clock with it, and
		// `Thinking… 12s` reads as the `Thought for 12s` it settles into.
		[
			"phase",
			label && (
				<>
					<span className="min-w-0 truncate text-th-text-secondary">
						{label}
					</span>
					{openedAt !== undefined && <TurnClock openedAt={openedAt} />}
				</>
			),
		],
		[
			"plan",
			words && (
				<Chip icon={<ListChecks aria-hidden className={CHIP_ICON} />}>
					{words.done}/{words.total}
				</Chip>
			),
		],
		[
			"agents",
			// At 0 too while the panel keeps settled entries, as after the turn:
			// the line always has something to close the panel by.
			agentsSection && (
				<Chip icon={<Bot aria-hidden className={CHIP_ICON} />}>
					{agentsSection.liveCount}
				</Chip>
			),
		],
		[FREE, free && <FreeText>{free}</FreeText>],
	];
	const jump = waiting && goToCall && (
		<GoToCallButton
			label="Go to call being read"
			height="h-4"
			onClick={() => goToCall(waiting.originToolUseId)}
		/>
	);

	return (
		// Drawn bare, its glyph on the text's left edge, so the settled turn's Copy
		// button takes the line's place without a sideways jump.
		<div className="mt-2 min-h-9 text-xs pointer-coarse:min-h-11">
			{/* Beside the line rather than around it, and filled only while the line
			    is up: announced when it appears, not on every switch between
			    working and thinking, which codex makes around almost every call. */}
			{writing && (
				// biome-ignore lint/a11y/useSemanticElements: a live announcement, not a form output
				<span role="status" className="sr-only">
					{shown && announceable ? ACTIVITY_VIEW.running.ariaLabel : ""}
				</span>
			)}
			{segments.some(([, segment]) => segment) && (
				<StatusRow
					// Blocked, the line does not spin: it leads with its first chip.
					glyph={label ? GLYPH : null}
					toggle={
						toggleable
							? {
									expanded: panel.expanded,
									onToggle: panel.onToggle,
									label: statusLineLabel({
										phase: label?.replace(/…$/, ""),
										plan: words,
										agents: agentsSection?.liveCount,
									}),
								}
							: undefined
					}
					jump={jump}
				>
					<StatusWords segments={segments} />
				</StatusRow>
			)}
			{toggleable && (
				<CollapsibleBody expanded={panel.expanded}>
					<Panel plan={plan} agents={agentsSection} thinking={thinkingText} />
				</CollapsibleBody>
			)}
		</div>
	);
}

/**
 * The agents chip on the right of the turn-end row, while a backgrounded agent
 * outlives the turn (docs/turn-progress-ui.md#21-where-it-is): `⧉ 1 · <named
 * agent and what it is doing> ›`, opening a panel of the agents alone. It stays
 * at `⧉ 0 · No agents running` while that panel is open.
 */
function LingeringAgents({
	agents,
	panel,
}: {
	agents: AgentsOverview;
	panel: TurnPanel;
}) {
	return (
		<StatusRow
			glyph={null}
			toggle={{
				expanded: panel.expanded,
				onToggle: panel.onToggle,
				label: statusLineLabel({ agents: agents.liveCount }),
			}}
		>
			<StatusWords
				segments={[
					[
						"agents",
						<Chip key="agents" icon={<Bot aria-hidden className={CHIP_ICON} />}>
							{agents.liveCount}
						</Chip>,
					],
					[
						FREE,
						<FreeText key={FREE}>
							{agents.named ? (
								<NamedAgent run={agents.named} />
							) : (
								<span className="min-w-0 truncate">
									{agentsLabel(agents.liveCount)}
								</span>
							)}
						</FreeText>,
					],
				]}
			/>
		</StatusRow>
	);
}

/**
 * The turn-end slot of a settled reply: the turn-end row, holding the status
 * line's height, with the agents chip at its right end — in place of the work
 * figures — on the one reply that `overviewMessageId` names after the turn.
 */
export function TurnEnd({
	messageId,
	...actions
}: { messageId: string } & Omit<MessageActionsProps, "aside">) {
	const { overviewMessageId, agents, panel } = useOverviewTail(messageId);
	const lingering = overviewMessageId === messageId;
	return (
		<>
			<MessageActions
				{...actions}
				aside={
					lingering ? (
						<div className="text-xs">
							<LingeringAgents agents={agents} panel={panel} />
						</div>
					) : undefined
				}
			/>
			{lingering && (
				<div className="text-xs">
					<CollapsibleBody expanded={panel.expanded}>
						<Panel agents={agents} />
					</CollapsibleBody>
				</div>
			)}
		</>
	);
}

export default TurnTail;
