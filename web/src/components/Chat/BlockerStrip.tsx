import { CircleHelp, CornerDownRight, Hourglass, Lock } from "lucide-react";
import { useState } from "react";
import type { SessionTurn, TurnBlocker } from "../../types/message";

interface Props {
	turn: SessionTurn;
	/** Scrolls the transcript to the card that is holding the turn up. */
	onJumpToRequest: (requestId: string) => void;
	/**
	 * A typed message went into a turn that was already running. The only receipt
	 * it gets: the reply above it keeps growing and nothing new appears under it,
	 * so without this line a message that landed and one that vanished look the
	 * same.
	 */
	sendPending?: boolean;
}

/**
 * Which blocker the strip speaks for. The same precedence the activity
 * derivation uses (docs/lifecycle-ui.md §1.2): permission first, because it is
 * the one that cannot degrade into a message and so is the one whose deadline
 * costs something; background last, because it is the one with nothing to press.
 */
function leadingBlocker(blockers: TurnBlocker[]): TurnBlocker | undefined {
	return (
		blockers.find((b) => b.kind === "permission") ??
		blockers.find((b) => b.kind === "question") ??
		blockers.find((b) => b.kind === "background")
	);
}

/** "14:02" in the reader's own locale. */
function formatSince(since: string): string | undefined {
	if (!since) return undefined;
	const at = new Date(since);
	if (Number.isNaN(at.getTime())) return undefined;
	return at.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

const STRIP_LINE =
	"flex flex-wrap items-center justify-center gap-1.5 px-3 py-2 text-th-text-muted text-xs";

// One bordered row above the composer, whichever of the four things it says.
const STRIP_FRAME = "shrink-0 border-th-border border-t";

// `touch-target` over a text line rather than a taller box: the strip's height
// is a statement's height, and growing it would push the composer down every
// time the agent asks something (docs/responsive-ui.md, hit areas). Written at
// module scope because that is the only helper shape the hit-area scan follows
// into a control (web/tests/touchTarget.ts, `interactiveControls`).
const STRIP_ACTION =
	"touch-target rounded px-1 underline transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";

/**
 * One line between the transcript and the composer, saying why the agent is
 * quiet — or, when it is not quiet, that a message reached the reply it is
 * writing (docs/lifecycle-ui.md §2.2).
 *
 * It borrows `ForkOriginBanner`'s chrome — centred, `text-xs`, `size-3` glyph,
 * muted — because both are one-line statements about the transcript rather than
 * controls, and the pane should have one vocabulary for them. It sits below the
 * list, where the fork banner sits above it, because it describes the
 * transcript's *end*.
 *
 * It holds no state of its own beyond whether the background detail is open:
 * everything it says is read from the session's turn and the transcript's tail,
 * and goes when they do.
 */
function BlockerStrip({ turn, onJumpToRequest, sendPending }: Props) {
	const [expanded, setExpanded] = useState(false);

	const blocker =
		turn.phase === "blocked" ? leadingBlocker(turn.blockers ?? []) : undefined;

	// The line is one of four things, and the branches below are in that order.
	// A prompt comes first: it is what the session is stuck on and what sending is
	// refused for. The receipt comes before a background wait because "nothing to
	// answer" is the older news of the two, and sending *is* allowed during one —
	// ranking it lower would leave the single state where a message lands with no
	// acknowledgement at all. A prompt and a receipt can be true at once, since the
	// agent can raise a request after the message went in.
	const prompt =
		blocker?.kind === "permission" || blocker?.kind === "question"
			? blocker
			: undefined;

	if (prompt) {
		const isQuestion = prompt.kind === "question";
		const Icon = isQuestion ? CircleHelp : Lock;
		const requestId = prompt.request_id;
		return (
			<div className={STRIP_FRAME}>
				<div className={STRIP_LINE}>
					<Icon className="size-3 shrink-0" aria-hidden="true" />
					{/* The second sentence is why the composer refuses to send, and it
					    is the same sentence for both: the request owns the agent's next
					    line of input, and the server refuses a message sent over it too.
					    A disabled Send with no reason on screen is the silent failure
					    the project forbids. */}
					<span>
						{isQuestion
							? "Waiting for your answer."
							: "Waiting for your permission."}{" "}
						Answer above or Stop before sending.
					</span>
					{/* The pill counts questions you cannot see; this states why the
					    agent is quiet. Both on screen at once is correct, and neither
					    reimplements the jump. */}
					{requestId && (
						<button
							type="button"
							onClick={() => onJumpToRequest(requestId)}
							className={STRIP_ACTION}
						>
							{isQuestion ? "Jump to question" : "Jump to request"}
						</button>
					)}
				</div>
			</div>
		);
	}

	if (sendPending) {
		return (
			<div className={STRIP_FRAME}>
				<div className={STRIP_LINE}>
					<CornerDownRight className="size-3 shrink-0" aria-hidden="true" />
					<span>Sent into the reply the agent is working on.</span>
				</div>
			</div>
		);
	}

	if (!blocker) return null;

	const since = formatSince(turn.since);
	return (
		<div className={STRIP_FRAME}>
			<div className={STRIP_LINE}>
				<Hourglass className="size-3 shrink-0" aria-hidden="true" />
				<span>Waiting on a background task — nothing to answer.</span>
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					aria-expanded={expanded}
					className={STRIP_ACTION}
				>
					Details
				</button>
			</div>
			{/* Two things a user who has waited an hour needs told before they reach
			    for Stop: nothing is stuck, and Stop is the only lever — there is no
			    per-task kill, because the model gives the host no way to end one task
			    without ending the turn. */}
			{expanded && (
				<p className="px-3 pb-2 text-center text-th-text-muted text-xs">
					{since
						? `Waiting on background tasks since ${since}. `
						: "Waiting on background tasks. "}
					The agent resumes on its own when they finish. Stopping ends the turn
					and loses the tasks.
				</p>
			)}
		</div>
	);
}

export default BlockerStrip;
