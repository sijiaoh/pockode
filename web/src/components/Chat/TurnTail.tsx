import { CircleDot } from "lucide-react";
import { useEffect, useState } from "react";
import { ACTIVITY_VIEW } from "../../lib/activity";
import { hasText, type LiveThinking, latestLine } from "../../lib/thinking";
import { formatElapsed } from "../../lib/toolRun";
import { CollapsibleBody, Spinner } from "../ui";
import { BareBody, BareRow } from "./BareRow";
import { ThoughtBody, ThoughtScroller } from "./ThinkingItem";
import { useTurnTail } from "./turnTailContext";

interface Props {
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

/**
 * How long the turn has been open. Its own component with its own one-second
 * interval — at every length, unlike a tool row's counter: `1m 4s` must not sit
 * for a minute — so the tick re-renders the clock and not the line.
 */
function TurnClock({ openedAt }: { openedAt: number }) {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	const elapsed = now - openedAt;
	// Not before three seconds, like a tool row's, so a turn that is over at once
	// never flashes a number.
	if (elapsed < 3000) return null;
	return (
		<span className="shrink-0 text-th-text-muted tabular-nums">
			{formatElapsed(elapsed)}
		</span>
	);
}

function ThinkingSoFar({ thinking }: { thinking: LiveThinking }) {
	return (
		<BareBody>
			<ThoughtScroller className="px-2.5">
				<div className="py-2">
					{thinking.joinedLate && (
						<p className="mb-2 text-th-text-muted">
							Earlier thinking appears in full when it finishes.
						</p>
					)}
					<ThoughtBody thought={{ ...thinking, redacted: false }} />
				</div>
			</ThoughtScroller>
		</BareBody>
	);
}

/**
 * The turn-end slot of the reply being written, while it is still being
 * written (docs/turn-progress-ui.md#2-the-tail-line): `Working 1m 4s`, or
 * `Thinking… 1m 4s · <latest line>`. It says that the turn is producing and
 * for how long, and nothing else — every other fact about the turn has an
 * owner of its own (§4 there).
 *
 * The slot keeps the turn-end row's height whether or not the line is drawn,
 * so a turn blocking and resuming moves nothing, and settling swaps the line
 * for the row in place.
 */
function TurnTail({ writing, placeholder }: Props) {
	const { phase, openedAt, thinking, onToggleThinking } = useTurnTail();
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
	// A blocked turn is not producing, and the attention strip says what it is
	// waiting on; the placeholder only speaks until the server does.
	const shown =
		writing && (phase === "running" || (placeholder && phase === "idle"));
	const live = shown && phase === "running" ? thinking : null;
	const text = live && hasText({ ...live, redacted: false });

	const latest = live ? latestLine(live.content || live.fullReasoning) : "";
	// The clock follows the word rather than the latest line: the line changes
	// length several times a second and would drag the clock with it, and
	// `Thinking… 12s` reads as the `Thought for 12s` it settles into. Only the
	// latest line gives way on a narrow screen.
	const words = (
		<span aria-hidden className="flex items-baseline gap-1.5">
			<span className="shrink-0 text-th-text-secondary">
				{live ? "Thinking…" : "Working"}
			</span>
			{openedAt !== undefined && <TurnClock openedAt={openedAt} />}
			{latest && (
				<>
					<span className="shrink-0 text-th-text-muted">·</span>
					<span className="min-w-0 truncate text-th-text-muted">{latest}</span>
				</>
			)}
		</span>
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
			{shown &&
				(live && text ? (
					<>
						<BareRow
							glyph={GLYPH}
							toggle={{
								expanded: live.expanded,
								onToggle: onToggleThinking,
								label: "Agent's thinking so far",
							}}
						>
							{words}
						</BareRow>
						<CollapsibleBody expanded={live.expanded}>
							<ThinkingSoFar thinking={live} />
						</CollapsibleBody>
					</>
				) : (
					<BareRow glyph={GLYPH}>{words}</BareRow>
				))}
		</div>
	);
}

export default TurnTail;
