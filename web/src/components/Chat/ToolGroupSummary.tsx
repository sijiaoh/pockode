import { Ban, Check } from "lucide-react";
import { Fragment } from "react";
import type { GroupSummary } from "../../lib/toolGroups";
import { stepsLabel } from "../../lib/toolRun";
import { toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import { Chip, Detail, RowButton, RunningGlyph, ToolMeta } from "./ToolRow";

interface Props {
	summary: GroupSummary;
	expanded: boolean;
	onToggle: () => void;
}

/**
 * The step a running group is on, worded as that call's own row words it, in
 * the `N steps · <latest>` grammar a subagent row already speaks. One line, so
 * the row is the same height running and settled.
 */
function CurrentStep({ summary }: { summary: GroupSummary }) {
	const workDir = useWSStore((state) => state.workDir);
	const run = summary.current;
	if (!run) return null;
	const call = toolSummary(run.name, run.input, workDir);
	return (
		// Every word of it moves, so it stays out of the button's accessible
		// name; the spinner says what is going on.
		<span aria-hidden className="flex items-baseline gap-1.5">
			<span className="shrink-0 text-th-text-secondary">
				{stepsLabel(summary.steps)}
			</span>
			<span className="shrink-0 text-th-text-muted">·</span>
			<span className="shrink-0 text-th-accent">{call.title}</span>
			{call.chip && <Chip>{call.chip}</Chip>}
			<Detail
				detail={call.detail}
				detailTail={call.detailTail}
				mono={call.mono}
			/>
			<ToolMeta run={run} />
		</span>
	);
}

/**
 * The one row a run of calls folds into (docs/tool-call-ui.md#groups). Never
 * red and never green: red belongs to the failed rows pinned under it, and a
 * group of successes is the transcript's ordinary case. No accent title when
 * settled either — that is what tells it apart from a tool row, which always
 * opens on one.
 */
export function ToolGroupSummary({ summary, expanded, onToggle }: Props) {
	if (summary.current) {
		return (
			<RowButton
				expanded={expanded}
				onToggle={onToggle}
				glyph={<RunningGlyph label="Tool calls running" />}
			>
				<CurrentStep summary={summary} />
			</RowButton>
		);
	}

	// A card waits on the user while folded calls still run: neither busy nor
	// done, so no spinner and no tick, and the count leads because it is the
	// one thing a narrow screen must not cut.
	const stillRunning = summary.running > 0;
	const segments = stillRunning
		? [`${summary.running} running`, ...summary.segments]
		: summary.segments;
	const Icon = summary.interrupted > 0 ? Ban : Check;
	return (
		<RowButton
			expanded={expanded}
			onToggle={onToggle}
			glyph={
				!stillRunning && summary.segments.length > 0 ? (
					<Icon
						className="mt-0.5 size-3 shrink-0 text-th-text-muted"
						aria-label={summary.interrupted > 0 ? "interrupted" : "done"}
					/>
				) : (
					// Nothing settled yet, or something folded still running, and
					// nothing spinning either: the group waits on a card that waits
					// on the user.
					<span className="mt-0.5 size-3 shrink-0" />
				)
			}
		>
			<span className="block truncate text-th-text-secondary">
				{segments.length === 0
					? stepsLabel(summary.steps)
					: segments.map((segment, index) => (
							<Fragment key={segment}>
								{index > 0 && <span className="text-th-text-muted"> · </span>}
								{segment}
							</Fragment>
						))}
			</span>
		</RowButton>
	);
}
