import type { ReactNode } from "react";
import type { SessionUsage } from "../../types/message";
import {
	formatContextPercent,
	formatCost,
	formatExactTokens,
	totalTokens,
} from "../../utils/tokens";
import { PanelSection } from "../ui";

interface Props {
	/** Undefined until the session's detail arrives, which is a state of its own. */
	usage?: SessionUsage;
	/** A fork's counters start at zero, and the history above them does not. */
	isForked: boolean;
}

/** Where the window has to be before its reading turns from a fact into a warning. */
const WARNING_RATIO = 0.75;
const ERROR_RATIO = 0.9;

function contextColor(ratio: number): string {
	if (ratio >= ERROR_RATIO) return "text-th-error";
	if (ratio >= WARNING_RATIO) return "text-th-warning";
	return "text-th-accent";
}

function contextFill(ratio: number): string {
	if (ratio >= ERROR_RATIO) return "bg-th-error";
	if (ratio >= WARNING_RATIO) return "bg-th-warning";
	return "bg-th-accent";
}

function Note({ children }: { children: ReactNode }) {
	return <p className="text-th-text-muted">{children}</p>;
}

/** A label and its figure, right-aligned so the figures below line up under each other. */
function Row({
	label,
	value,
	valueClass,
	indent = false,
}: {
	label: string;
	value: string;
	valueClass?: string;
	indent?: boolean;
}) {
	return (
		<div
			className={`flex items-baseline justify-between gap-3 ${
				indent ? "pl-3 text-th-text-muted" : "text-th-text-secondary"
			}`}
		>
			<span>{label}</span>
			<span
				className={`tabular-nums ${
					valueClass ?? (indent ? "text-th-text-muted" : "text-th-text-primary")
				}`}
			>
				{value}
			</span>
		</div>
	);
}

// `contextWindow`, not `window`: the DOM global is in scope here, and a reader
// checking what this bar is sized against should not have to work out which one
// is meant.
function ContextBlock({ usage }: { usage: SessionUsage }) {
	const contextWindow = usage.context_window ?? 0;
	if (contextWindow <= 0) {
		return <Note>Context window not reported by this agent.</Note>;
	}

	// Zero is not a measurement of zero: the store only records a reading the
	// agent actually took (see server/session/usage.go), and no prompt is empty.
	// This is the gap between the window — which arrives with the agent's first
	// frame — and the end of the first turn, and it is where a session sits whose
	// reading was taken by a build that measured it wrong and has been dropped.
	const used = usage.context_tokens ?? 0;
	if (used <= 0) {
		return <Note>Context not measured yet.</Note>;
	}

	const ratio = used / contextWindow;
	const spoken = `${formatExactTokens(used)} of ${formatExactTokens(contextWindow)} tokens`;
	// The window, except once the reading is past it: an agent is allowed to
	// overshoot its own window, and an aria-valuenow above aria-valuemax is out of
	// range — a value a screen reader may discard or renormalise, precisely when
	// the reading most needs announcing. Widening the range clamps nothing: the
	// percentage and `spoken` still carry the reading against the real window.
	const rangeMax = Math.max(contextWindow, used);

	return (
		<div>
			<Row
				label="Context"
				value={formatContextPercent(used, contextWindow)}
				valueClass={contextColor(ratio)}
			/>
			{/* `progressbar`, not ARIA's `meter`: it is the role screen readers
			    actually announce. The colour is never the only carrier — the
			    percentage above and the counts below say the same thing in words. */}
			<div
				className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-th-bg-tertiary"
				role="progressbar"
				aria-label="Context"
				aria-valuemin={0}
				aria-valuemax={rangeMax}
				aria-valuenow={used}
				aria-valuetext={spoken}
			>
				<div
					className={`h-full rounded-full ${contextFill(ratio)}`}
					style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
				/>
			</div>
			<p className="mt-1 text-th-text-muted">{spoken}</p>
		</div>
	);
}

function TotalBlock({ usage, total }: { usage: SessionUsage; total: number }) {
	// A sub-row per counter the agent actually filled: a Codex session shows the
	// two it reports, and nobody reads "Cache write 0" on an agent with no cache.
	const breakdown = [
		["Input", usage.input_tokens],
		["Output", usage.output_tokens],
		["Cache read", usage.cache_read_tokens],
		["Cache write", usage.cache_write_tokens],
	] as const;

	return (
		<div>
			<Row label="Session total" value={formatExactTokens(total)} />
			{breakdown
				.filter(([, count]) => count > 0)
				.map(([label, count]) => (
					<Row
						key={label}
						label={label}
						value={formatExactTokens(count)}
						indent
					/>
				))}
		</div>
	);
}

/** The three blocks, once the session's detail is in hand. */
function UsageBody({
	usage,
	isForked,
}: {
	usage: SessionUsage;
	isForked: boolean;
}) {
	const total = totalTokens(usage);

	return (
		<>
			{/* Nothing at all reported yet says so once, below: a session whose agent
			    has not spoken has not declined to report a window, and the
			    missing-window line is for the agent that reports counters without
			    one. A window on its own still shows — a resumed session reports one
			    before it has spent anything. */}
			{((usage.context_window ?? 0) > 0 || total > 0) && (
				<ContextBlock usage={usage} />
			)}
			<div>
				{/* The permanent button makes this state a real one, and it has to say
				    something: an empty panel reads as a broken one, and zeros would
				    claim the agent reported zeros when it reported nothing. */}
				{total === 0 ? (
					<Note>Nothing reported yet.</Note>
				) : (
					<TotalBlock usage={usage} total={total} />
				)}
				{/* The copied conversation is on screen right behind this panel, and
				    the tokens behind it were spent by the session it came from.
				    Under the empty total too, which is where a fork starts and where
				    a long history over no total needs the explanation most. */}
				{isForked && <Note>Since this session was forked.</Note>}
			</div>
			{/* Absent, not `$0.00`: an agent that reports no price and one that
			    charged nothing would otherwise look identical. */}
			{usage.cost_usd !== undefined && (
				<Row label="Cost" value={formatCost(usage.cost_usd)} />
			)}
		</>
	);
}

/**
 * What this session has consumed, as its agent reported it — the first section
 * of the session info panel.
 *
 * Every figure is the agent's own: nothing is estimated from a price table, and
 * what an agent never reported is said in words rather than shown as a zero.
 */
function SessionUsageSection({ usage, isForked }: Props) {
	return (
		<PanelSection title="Usage">
			<div className="space-y-2 px-3 pb-2 text-xs">
				{usage ? (
					<UsageBody usage={usage} isForked={isForked} />
				) : (
					<Note>Loading…</Note>
				)}
			</div>
		</PanelSection>
	);
}

export default SessionUsageSection;
