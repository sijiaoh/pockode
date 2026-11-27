import { Ban, Bot, Check, ChevronRight, CircleDot, X } from "lucide-react";
import {
	type MouseEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	formatDuration,
	formatElapsed,
	type ToolSecondLine,
	toolRunDurationMs,
} from "../../lib/toolRun";
import { SUBAGENT_TITLE } from "../../lib/toolSummary";
import { callLines } from "../../lib/turnChanges";
import type { ToolRun, ToolRunStatus } from "../../types/message";
import { Spinner } from "../ui";
import { LineCountsLabel } from "./ProposedChange";
import { useFoldLanding } from "./useFoldLanding";
import { useStuckBar } from "./useStuckBar";

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
 * A run's status in words, for a control that names the run in a label of its
 * own and so hides the glyph that would otherwise say it.
 */
export function toolStatusWord(status: ToolRunStatus): string {
	if (status === "running") return "running";
	if (status === "background") return "running in the background";
	return settledGlyphs[status].label;
}

/**
 * What a row shows while its work is going: a spinner, or under reduced motion
 * a still dot — the motion is decoration, and `Spinner` does not stop itself.
 * Accent then, as the turn's tail line is, so the dot still reads as "live"
 * beside the muted ticks of the settled rows.
 */
export function RunningGlyph({
	label,
	muted,
}: {
	label: string;
	/** For work that is not the user's to watch, such as a review under way. */
	muted?: boolean;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: not a form's output, as in Spinner itself
		<span
			role="status"
			aria-label={label}
			// Aligned with line 1 rather than centred on a row that may have two
			// lines, same as the chevron beside it.
			className={`mt-0.5 flex size-3 shrink-0 items-center justify-center ${muted ? "text-th-text-muted" : ""}`}
		>
			{/* Hidden because `Spinner` is a status of its own, and the label is
			    this span's: it has to outlive whichever glyph is showing. */}
			<span aria-hidden className="flex motion-reduce:hidden">
				<Spinner variant="current" size="h-3 w-3" srText={null} />
			</span>
			<CircleDot
				aria-hidden
				className={`hidden size-3 motion-reduce:block ${muted ? "text-th-text-muted" : "text-th-accent"}`}
			/>
		</span>
	);
}

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
		return <RunningGlyph label={`${name} running`} />;
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
export function Chip({ children }: { children: string }) {
	return (
		<span className="shrink-0 rounded bg-th-accent/20 px-1.5 py-0.5 text-th-text-primary">
			{children}
		</span>
	);
}

/**
 * A subagent's title as its row draws it: the agent mark, then the title,
 * capped so the detail after it keeps room. Shared with whatever names that
 * subagent elsewhere — a nested card's asker line — so the two read letter for
 * letter alike. `spoken` is what a screen reader hears in place of the mark.
 */
export function AgentTitle({
	title,
	spoken,
	className,
}: {
	title: string;
	spoken?: string;
	className: string;
}) {
	return (
		<span
			className={`flex min-w-0 max-w-[45%] shrink-0 items-baseline gap-1 ${className}`}
		>
			<Bot aria-hidden className="size-3 shrink-0 self-center" />
			<span className="truncate">
				{spoken && <span className="sr-only">{spoken}</span>}
				{title}
			</span>
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
export function Detail({
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
 * How long a run has been going, from its start on this client's clock.
 *
 * Its own component with its own interval, so the tick re-renders the counter
 * and not the row.
 */
function ElapsedCounter({
	seenAt,
	separated,
}: {
	seenAt: Date;
	/**
	 * It follows text on the same line, so it brings its own `·`: drawn only
	 * with the number, never left dangling before the three seconds are up.
	 */
	separated?: boolean;
}) {
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
			{separated && "· "}
			{formatElapsed(elapsed)}
		</span>
	);
}

/**
 * What a finished call measured besides its time: the lines an edit changed,
 * or the code a command exited with. Muted both, whatever happened: red is the
 * failed row's already, three times over, and green and red counts in a stack
 * of rows would read as calls that passed and failed. The coloured counts are
 * the body's (docs/tool-call-ui.md).
 *
 * Counts only for a call that succeeded, since only that one changed anything
 * — the turn's tally's rule, and its figure. An exit code whenever one other
 * than zero was measured: an engine that reports one has already failed the
 * call for it, so this is never drawn on a row that succeeded.
 */
function ToolOutcomeFigure({ run }: { run: ToolRun }) {
	// Memoized: a Codex add's patch is a whole file and a Write's content is
	// one, and a settled row re-renders with its list. A run is replaced, not
	// mutated, when it changes.
	const lines = useMemo(
		() => (run.status === "success" ? callLines(run) : null),
		[run],
	);
	if (run.exitCode !== undefined && run.exitCode !== 0) {
		return (
			<span className="shrink-0 font-mono tabular-nums text-th-text-muted">
				exit {run.exitCode}
			</span>
		);
	}
	if (!lines || (lines.added === 0 && !lines.removed)) return null;
	return (
		<span className="flex shrink-0 items-baseline">
			<span className="sr-only">lines </span>
			<LineCountsLabel lines={lines} colored={false} />
		</span>
	);
}

/**
 * How long a finished call took, or how long a live one has been going.
 *
 * A finished call shows only a measured duration — the engine's, or the one
 * the server observed (`toolRunDurationMs` decides) — and only from 1s up. A
 * live counter needs the start on this client's clock (`seenAt`), so a run
 * whose start cannot be placed there, and a year-old transcript, draw no
 * stopwatches.
 */
function ToolTime({ run }: { run: ToolRun }) {
	const live = run.status === "running" || run.status === "background";
	if (!live) {
		const durationMs = toolRunDurationMs(run);
		if (durationMs === undefined || durationMs < 1000) return null;
		return (
			<span className="shrink-0 text-th-text-muted">
				{formatDuration(durationMs)}
			</span>
		);
	}
	if (!run.seenAt) return null;
	return <ElapsedCounter seenAt={run.seenAt} />;
}

/**
 * The right-hand figures: what the call measured, then its time — last, so
 * the times of a stack of rows stay in one column. Neither is ever truncated;
 * the detail gives way.
 */
export function ToolMeta({ run }: { run: ToolRun }) {
	return (
		<span className="flex shrink-0 items-baseline gap-2 empty:hidden">
			<ToolOutcomeFigure run={run} />
			<ToolTime run={run} />
		</span>
	);
}

interface Props {
	expanded: boolean;
	onToggle: () => void;
	glyph: ReactNode;
	title: string;
	/**
	 * Whether the title names an agent rather than a tool — a subagent's.
	 * It is led by the agent mark so `Explore` does not read as a tool called
	 * Explore, and capped, being whatever the agent's author typed
	 * (docs/tool-call-ui.md#line-1-the-agent-then-what-it-was-asked).
	 */
	agent?: boolean;
	/** A short label after the title, such as an MCP server. */
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
	/**
	 * A second line with structure of its own rather than one string — a
	 * subagent's step count beside what it is doing. Wins over `secondLine`.
	 */
	richSecondLine?: {
		content: ReactNode;
		live: boolean;
		/**
		 * Drawn under the line, wherever the line goes — in the button while
		 * the row is closed, under the bar while it is open: a subagent's step
		 * window. Spans, for the button's sake.
		 */
		below?: ReactNode;
	} | null;
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

interface RowButtonProps {
	expanded: boolean;
	/** Handed the press, for a caller that needs the button it came from. */
	onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
	glyph: ReactNode;
	error?: boolean;
	toggleable?: boolean;
	/** The id of the body the row opens, when the body is a sibling it names. */
	controls?: string;
	/** The accessible name, for a row whose visible words do not read as one. */
	label?: string;
	/**
	 * Drawn without the chevron column: a row standing for another one, which
	 * it goes to rather than opens, with no column of rows to line up with.
	 */
	noLead?: boolean;
	/**
	 * `data-*` attributes for the button, for a caller that finds it again by
	 * one: an opener of a subagent's transcript (`SUBAGENT_OPENER_ATTR`).
	 */
	data?: Record<`data-${string}`, string>;
	/** The text column: line 1 and, when there is one, the second line. */
	children: ReactNode;
}

// The row's box, a button or not: one line sits in the middle of the touch
// floor, two fill it. The floor is restated as `--row-height` in
// src/index.css, for what stacks under a pinned bar; it stays spelled out here
// because this is what the touch-target scan reads.
const ROW_BOX =
	"flex min-h-9 w-full flex-col justify-center px-2 py-1.5 text-left pointer-coarse:min-h-11 sm:px-2.5";

/** The two columns inside the box; see the file comment. */
function RowColumns({
	lead,
	glyph,
	children,
}: {
	lead: ReactNode;
	glyph: ReactNode;
	children: ReactNode;
}) {
	return (
		<span className="flex w-full items-start gap-1.5">
			{lead}
			{glyph}
			<span className="min-w-0 flex-1">{children}</span>
		</span>
	);
}

// A blank keeps the rows aligned with the ones that do open.
const NO_CHEVRON = <span className="mt-0.5 size-3 shrink-0" />;

/**
 * The box every row in a list is drawn in — a tool row, and the summary a run
 * of them folds into — so the two cannot drift apart in height, padding or
 * where the glyph sits.
 */
export function RowButton({
	expanded,
	onToggle,
	glyph,
	error,
	toggleable = true,
	controls,
	label,
	noLead,
	data,
	children,
}: RowButtonProps) {
	return (
		<button
			type="button"
			{...data}
			onClick={onToggle}
			aria-expanded={toggleable ? expanded : undefined}
			aria-controls={toggleable ? controls : undefined}
			aria-label={label}
			// The row is the only tap target on its line, so it takes the touch
			// floor directly rather than wearing an overlay: there is room to grow
			// the box, and a real box is always simpler.
			//
			// A column centred on the cross axis, holding the two-column row: one
			// line sits in the middle of the floor instead of along its top, and two
			// lines fill it, with the glyph still level with the first.
			//
			// A failure tints the row itself — the list draws no frame per row to
			// redden, and the body under it stays neutral, since a failed subagent
			// opens a whole report there. The ring is inset because the list clips
			// whatever is drawn outside a row.
			className={`${ROW_BOX} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${error ? "bg-th-error/10 hover:bg-th-error/15" : "hover:bg-th-overlay-hover"}`}
		>
			<RowColumns
				lead={
					noLead ? null : toggleable ? (
						<ChevronRight
							className={`mt-0.5 size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
						/>
					) : (
						NO_CHEVRON
					)
				}
				glyph={glyph}
			>
				{children}
			</RowColumns>
		</button>
	);
}

/**
 * A row with nothing under it and nothing to do: `RowButton`'s box and
 * columns, but not a button, since a tap that can only learn there is nothing
 * here is a tap spent for nothing.
 */
export function StaticRow({
	glyph,
	children,
}: {
	glyph: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className={ROW_BOX}>
			<RowColumns lead={NO_CHEVRON} glyph={glyph}>
				{children}
			</RowColumns>
		</div>
	);
}

/**
 * A line under a row — or over it — outside its button, on the row's columns:
 * the text sits in the title's column, and `glyph` (blank by default) in the
 * glyph's. For what a row says beside itself that the row's button cannot
 * contain: a control of its own, or a fact about the request it stands for.
 */
export function RowSubline({
	glyph = NO_CHEVRON,
	above = false,
	children,
}: {
	glyph?: ReactNode;
	/** Drawn over the row rather than under it, so padded at its top. */
	above?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={`px-2 sm:px-2.5 ${above ? "pt-1.5" : "pb-1.5"}`}>
			<RowColumns lead={NO_CHEVRON} glyph={glyph}>
				{children}
			</RowColumns>
		</div>
	);
}

type FirstLineProps = Pick<
	Props,
	| "title"
	| "agent"
	| "chip"
	| "background"
	| "detail"
	| "detailTail"
	| "detailMono"
	| "meta"
	| "error"
>;

/**
 * What a row's first line holds, inside a `flex items-baseline` span of the
 * caller's. Its own component so that a run drawn again elsewhere — an entry in
 * the agents list — is worded and cut by the code that draws its row.
 */
export function ToolRowFirstLine({
	title,
	agent,
	chip,
	background,
	detail,
	detailTail,
	detailMono,
	meta,
	error,
}: FirstLineProps) {
	return (
		<>
			{agent ? (
				<AgentTitle
					title={title}
					// What the mark says to the eye; a row already titled
					// `Subagent` would say it twice.
					spoken={title !== SUBAGENT_TITLE ? "Subagent " : undefined}
					className="text-th-accent"
				/>
			) : (
				<span className="shrink-0 text-th-accent">{title}</span>
			)}
			{chip && <Chip>{chip}</Chip>}
			{background && <Chip>background</Chip>}
			<Detail
				detail={detail}
				detailTail={detailTail}
				mono={detailMono}
				error={error}
			/>
			{meta}
		</>
	);
}

/** A row's second line, when it has one; see `ToolRow`. */
export function ToolRowSecondLine({
	secondLine,
	richSecondLine,
}: Pick<Props, "secondLine" | "richSecondLine">) {
	if (richSecondLine) {
		return (
			<>
				<span
					aria-hidden={richSecondLine.live}
					className="flex min-w-0 items-baseline gap-1.5 text-th-text-muted"
				>
					{richSecondLine.content}
				</span>
				{richSecondLine.below}
			</>
		);
	}
	if (!secondLine) return null;
	return (
		<span
			// Hidden from the accessible name while it moves, exposed once it has
			// settled: the spinner already says the call is running, and a settled
			// background outcome is the answer the user was waiting for.
			aria-hidden={secondLine.live}
			className={`block truncate text-th-text-muted ${secondLine.mono ? "font-mono" : ""}`}
		>
			{secondLine.text}
			{secondLine.since && (
				<>
					{" "}
					<ElapsedCounter seenAt={secondLine.since} separated />
				</>
			)}
		</span>
	);
}

/**
 * An open row's first line sticks to the top of the transcript until its body
 * ends, so a reader several screens into a result still sees which call it is
 * and can fold it from there (docs/tool-call-ui.md#the-sticky-title-line). It
 * is the row's own button that sticks, inside a bar that repaints the ground
 * it passes over: one control, wherever it is drawn.
 *
 * The second line is therefore not in the button while the row is open — a
 * pinned bar is one line, and the second goes on in the flow under it, aligned
 * as before. That is the one way an open row is drawn differently from a closed
 * one: a two-line row grows by the floor the bar keeps for its first line.
 *
 * Folding it leaves the reader on the row, wherever it was folded from
 * (`useFoldLanding`).
 */
export function ToolRow({
	expanded,
	onToggle,
	glyph,
	title,
	agent,
	chip,
	background,
	detail,
	detailTail,
	detailMono,
	meta,
	secondLine,
	richSecondLine,
	error,
	toggleable = true,
}: Props) {
	const barRef = useRef<HTMLDivElement>(null);
	const titleRef = useRef<HTMLSpanElement>(null);
	const sticky = expanded && toggleable;
	useStuckBar(barRef, sticky);
	const beforeFold = useFoldLanding(barRef, titleRef, expanded);

	const second = (
		<ToolRowSecondLine
			secondLine={secondLine}
			richSecondLine={richSecondLine}
		/>
	);
	const hasSecond = !!(richSecondLine || secondLine);

	return (
		<>
			<div ref={barRef} className={sticky ? "row-bar" : undefined}>
				<RowButton
					expanded={expanded}
					onToggle={() => {
						if (sticky) beforeFold();
						onToggle();
					}}
					glyph={glyph}
					error={error}
					toggleable={toggleable}
				>
					<span ref={titleRef} className="flex items-baseline gap-1.5">
						<ToolRowFirstLine
							title={title}
							agent={agent}
							chip={chip}
							background={background}
							detail={detail}
							detailTail={detailTail}
							detailMono={detailMono}
							meta={meta}
							error={error}
						/>
					</span>
					{!sticky && second}
				</RowButton>
			</div>
			{sticky && hasSecond && (
				// The row's box and columns without its floor, so the line sits
				// where it did under the title; and its tint, being the row's.
				<div
					className={`px-2 pb-1.5 sm:px-2.5 ${error ? "bg-th-error/10" : ""}`}
				>
					<RowColumns lead={NO_CHEVRON} glyph={NO_CHEVRON}>
						{second}
					</RowColumns>
				</div>
			)}
		</>
	);
}
