import { Ban, Check, ChevronRight, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
	formatDuration,
	formatElapsed,
	type ToolSecondLine,
} from "../../lib/toolRun";
import type { ToolRun, ToolRunStatus } from "../../types/message";
import { Spinner } from "../ui";

/**
 * The one line every tool-shaped row in the transcript is drawn as: a tool
 * call, a subagent call, a permission card. A user who approved a command and
 * then reads the row that ran it should be looking at the same string,
 * truncated the same way (docs/tool-call-ui.md).
 *
 * Structurally two columns — a fixed leading column for the chevron and the
 * glyph, and a `min-w-0 flex-1` text column — so the second line aligns under
 * the title for free and the alignment cannot drift.
 */

// Running has no entry: it is the one state shown as a spinner, not an icon.
const settledGlyphs: Record<
	Exclude<ToolRunStatus, "running" | "background">,
	{ Icon: typeof Check; color: string; label: string }
> = {
	// Muted, not green. A session has hundreds of successful rows, and a green
	// tick on each one costs the red X its salience.
	success: { Icon: Check, color: "text-th-text-muted", label: "succeeded" },
	error: { Icon: X, color: "text-th-error", label: "failed" },
	interrupted: { Icon: Ban, color: "text-th-text-muted", label: "interrupted" },
};

/**
 * The single place a run states its status. A spinner means the work is still
 * going — `background` included, because it is: the badge beside it is what
 * says the conversation moved on without it.
 */
export function ToolStatusGlyph({
	status,
	name,
}: {
	status: ToolRunStatus;
	name: string;
}) {
	if (status === "running" || status === "background") {
		return (
			<Spinner
				variant="current"
				size="h-3 w-3"
				// Aligned with line 1 rather than centred on a row that may have
				// two lines, same as the chevron beside it.
				className="mt-0.5 shrink-0"
				srText={`${name} running`}
			/>
		);
	}
	const { Icon, color, label } = settledGlyphs[status];
	return (
		<Icon className={`mt-0.5 size-3 shrink-0 ${color}`} aria-label={label} />
	);
}

/**
 * A word about the call that is not its title: which subagent is running it,
 * which MCP server it belongs to, or that it went to the background.
 */
function Chip({ children }: { children: string }) {
	return (
		<span className="shrink-0 rounded bg-th-accent/20 px-1.5 py-0.5 text-th-text-primary">
			{children}
		</span>
	);
}

/**
 * The part of the row that identifies this particular call, cut to whatever
 * width is left.
 *
 * `truncate` removes the end of a string, and a path's end is its file name —
 * the one part that identifies it — so a path arrives here already split and
 * only the directories are allowed to disappear. There is no dependable CSS for
 * a leading ellipsis (`direction: rtl` reorders punctuation), which is why this
 * is two spans rather than one rule.
 */
function Detail({
	detail,
	detailTail,
	mono,
	error,
}: {
	detail: string;
	detailTail?: string;
	mono?: boolean;
	error?: boolean;
}) {
	if (!detail && !detailTail) return null;
	const monoClass = mono ? "font-mono" : "";
	// Status outranks the two rungs: on a failed row the head/tail contrast must
	// not survive as a second colour language.
	const headClass = error ? "text-th-error" : "text-th-text-muted";
	const tailClass = error ? "text-th-error" : "text-th-text-secondary";

	return (
		<span className={`flex min-w-0 flex-1 items-baseline ${monoClass}`}>
			<span className={`truncate ${headClass}`}>{detail}</span>
			{detailTail && (
				<span className={`max-w-[70%] shrink-0 truncate ${tailClass}`}>
					{detailTail}
				</span>
			)}
		</span>
	);
}

/**
 * How long a run this client watched start has been going.
 *
 * Its own component with its own interval, so the tick re-renders the counter
 * and not the row.
 */
function ElapsedCounter({ seenAt }: { seenAt: Date }) {
	const [now, setNow] = useState(() => Date.now());
	const elapsed = now - seenAt.getTime();
	// Every second while the number is seconds, every minute once it is not: a
	// task that has been running for half an hour has no use for 1,800 wake-ups
	// that redraw the same string.
	const period = elapsed < 60_000 ? 1000 : 60_000;

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), period);
		return () => clearInterval(timer);
	}, [period]);

	// Not before three seconds, so the calls that finish instantly — nearly all
	// of them — never flash a number.
	if (elapsed < 3000) return null;
	return (
		<span className="shrink-0 text-th-text-muted">
			{formatElapsed(elapsed)}
		</span>
	);
}

/**
 * The right-hand figure: how long a finished call took, or how long a live one
 * has been going.
 *
 * A finished call shows only what the engine measured — Codex reports a
 * duration, Claude reports none — because a duration made up from arrival times
 * would be wrong on every replay. A live counter needs `seenAt`, which only a
 * run this client saw start has, so a year-old transcript draws no stopwatches.
 */
export function ToolMeta({ run }: { run: ToolRun }) {
	const live = run.status === "running" || run.status === "background";
	if (!live) {
		if (run.durationMs === undefined || run.durationMs < 1000) return null;
		return (
			<span className="shrink-0 text-th-text-muted">
				{formatDuration(run.durationMs)}
			</span>
		);
	}
	if (!run.seenAt) return null;
	return <ElapsedCounter seenAt={run.seenAt} />;
}

interface Props {
	expanded: boolean;
	onToggle: () => void;
	glyph: ReactNode;
	title: string;
	/** A short label after the title: a subagent type, an MCP server. */
	chip?: string;
	/**
	 * Whether this call left work running past the turn. Drawn as a second chip,
	 * and it stays after the run settles: "this ran in the background" is a
	 * permanent fact about the call, and it is what tells a reader the result
	 * under the row arrived after the agent had moved on.
	 */
	background?: boolean;
	detail: string;
	detailTail?: string;
	detailMono?: boolean;
	/** The right-hand figure, when the row has one. */
	meta?: ReactNode;
	secondLine?: ToolSecondLine | null;
	/** Failure is the only saturated colour in a stack of rows. */
	error?: boolean;
	/**
	 * Whether there is anything under this row. A tool call always has — its
	 * invocation, at least, which is why its chevron is unconditional — but a
	 * permission card for a tool that takes no input has nothing to open, and a
	 * chevron promising otherwise is a dead tap.
	 */
	toggleable?: boolean;
}

export function ToolRow({
	expanded,
	onToggle,
	glyph,
	title,
	chip,
	background,
	detail,
	detailTail,
	detailMono,
	meta,
	secondLine,
	error,
	toggleable = true,
}: Props) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={toggleable ? expanded : undefined}
			// The row is the only tap target on its line, so it takes the touch
			// floor directly rather than wearing an overlay: there is room to grow
			// the box, and a real box is always simpler.
			className="flex min-h-[36px] w-full items-start gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover pointer-coarse:min-h-11 sm:p-2.5"
		>
			{toggleable ? (
				<ChevronRight
					className={`mt-0.5 size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
			) : (
				// A blank keeps the rows aligned with the ones that do open.
				<span className="mt-0.5 size-3 shrink-0" />
			)}
			{glyph}
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline gap-1.5">
					<span className="shrink-0 text-th-accent">{title}</span>
					{chip && <Chip>{chip}</Chip>}
					{background && <Chip>background</Chip>}
					<Detail
						detail={detail}
						detailTail={detailTail}
						mono={detailMono}
						error={error}
					/>
					{meta}
				</span>
				{secondLine && (
					<span
						// Hidden from the accessible name while it moves, exposed once
						// it has settled: the spinner already says the call is running,
						// and a settled background outcome is the answer the user was
						// waiting for.
						aria-hidden={secondLine.live}
						className={`block truncate text-th-text-muted ${secondLine.mono ? "font-mono" : ""}`}
					>
						{secondLine.text}
					</span>
				)}
			</span>
		</button>
	);
}
