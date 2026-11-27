import { Ban, Check, CircleHelp, X } from "lucide-react";
import type { RecentStep, StepMark } from "../../lib/subagentRun";
import { isTaskTool, toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import { AgentTitle, Detail, RunningGlyph, ToolMeta } from "./ToolRow";

const settledIcons: Record<Exclude<StepMark, "running">, typeof Check> = {
	waiting: CircleHelp,
	success: Check,
	error: X,
	interrupted: Ban,
};

/**
 * A step's status in the shapes its own row's glyph takes, all muted — never
 * red, not even for a step that failed: red on a subagent row is the subagent's
 * own outcome, and the shape alone says a step failed.
 */
function StepGlyph({ mark }: { mark: StepMark }) {
	if (mark === "running") {
		return (
			<span className="flex self-center">
				<RunningGlyph label="running" muted />
			</span>
		);
	}
	const Icon = settledIcons[mark];
	return <Icon className="size-3 shrink-0 self-center text-th-text-muted" />;
}

/**
 * A call worded the way its own row words it: its title — in the secondary
 * colour, since two accent titles on one row would make the child read as the
 * row — then its detail. A subagent reads as its own row's title and
 * description.
 */
export function StepCallLabel({
	name,
	input,
}: {
	name: string;
	input: unknown;
}) {
	const workDir = useWSStore((state) => state.workDir);
	const summary = toolSummary(name, input, workDir);
	return (
		<>
			{isTaskTool(name) ? (
				<AgentTitle title={summary.title} className="text-th-text-secondary" />
			) : (
				<span className="shrink-0 text-th-text-secondary">
					{summary.chip ? `${summary.title} ${summary.chip}` : summary.title}
				</span>
			)}
			<Detail
				detail={summary.detail}
				detailTail={summary.detailTail}
				mono={summary.mono}
			/>
		</>
	);
}

/**
 * A subagent row's newest steps, one per line, oldest at the top
 * (docs/tool-call-ui.md#the-step-window). Spans, since it is drawn inside the
 * row's button while the row is closed; hidden from assistive tech, being a
 * moving view of steps the Process lists accessibly.
 *
 * `frozen` is a settled row's: its steps stay as the reducer left them, and
 * carry no time — a counter ticking on a settled row would be a lie about it.
 */
export function SubagentStepWindow({
	steps,
	frozen,
}: {
	steps: RecentStep[];
	frozen: boolean;
}) {
	return (
		<span aria-hidden className="block" data-step-window>
			{steps.map((step) => (
				<span
					key={step.id}
					className="flex min-w-0 items-baseline gap-1.5 text-xs"
				>
					<StepGlyph mark={step.mark} />
					{step.label.kind === "call" ? (
						<StepCallLabel name={step.label.name} input={step.label.input} />
					) : (
						<>
							<span className="shrink-0 text-th-text-secondary">Question</span>
							<Detail detail={step.label.text} />
						</>
					)}
					{!frozen && step.mark === "running" && step.run && (
						<span className="ml-auto">
							<ToolMeta run={step.run} />
						</span>
					)}
				</span>
			))}
		</span>
	);
}
