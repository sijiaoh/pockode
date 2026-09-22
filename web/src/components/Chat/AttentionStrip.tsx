import { CircleHelp, CornerDownRight, Hourglass, Lock } from "lucide-react";
import { useState } from "react";
import type { SessionTurn, TurnBlocker } from "../../types/message";

interface Props {
	turn: SessionTurn;
	/** Scrolls the transcript to the card that is holding the turn up. */
	onJumpToRequest: (requestId: string) => void;
	/**
	 * Opens the answer panel. The strip is the one way back into it once it has
	 * been closed, which is why this row's action is a button rather than the
	 * underlined text the other three wear.
	 */
	onAnswer?: () => void;
	/**
	 * Whether the answer panel is up. Its row then does not exist: the panel is
	 * already that sentence, in full and on screen, and this row would be it
	 * said twice — with a button that reopens what is open.
	 *
	 * Passed in rather than worked out here, so the row and the panel change in
	 * the same frame (docs/answering-ui.md).
	 */
	answerPanelOpen?: boolean;
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
 * the one with something to press; background last, because it is the one with
 * nothing.
 */
function leadingBlocker(blockers: TurnBlocker[]): TurnBlocker | undefined {
	return (
		blockers.find((b) => b.kind === "permission") ??
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
 * One line between the transcript and the composer, saying what needs the user
 * (docs/lifecycle-ui.md §2.2).
 *
 * It used to be `BlockerStrip`, and the rename is the design: two of its four
 * rows were never about a blocker — a posted question does not block a turn at
 * all, and the send receipt never did — so a name describing one row in four
 * was a name the next reader had to work around.
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
function AttentionStrip({
	turn,
	onJumpToRequest,
	onAnswer,
	answerPanelOpen,
	sendPending,
}: Props) {
	const [expanded, setExpanded] = useState(false);

	const blocker =
		turn.phase === "blocked" ? leadingBlocker(turn.blockers ?? []) : undefined;
	const unanswered = turn.unanswered?.length ?? 0;

	// The line is one of four things, and the branches below are in that order:
	// permission, unanswered questions, the send receipt, a background wait.
	//
	// A permission request comes first, and now for a sharper reason than
	// precedence: it is the only row the composer is disabled under, and the only
	// state in which answering anything is refused by the server — the CLI holding
	// a request open reads nothing else, so even an answer message cannot be
	// delivered. The strip has to say the thing that must happen first.
	//
	// The receipt comes before a background wait because "nothing to answer" is
	// the older news of the two, and sending *is* allowed during one — ranking
	// it lower would leave the single state where a message lands with no
	// acknowledgement at all. A prompt and a receipt can be true at once, since
	// the agent can raise a request after the message went in.
	const prompt = blocker?.kind === "permission" ? blocker : undefined;

	if (prompt) {
		const requestId = prompt.request_id;
		return (
			<div className={STRIP_FRAME}>
				<div className={STRIP_LINE}>
					<Lock className="size-3 shrink-0" aria-hidden="true" />
					{/* The second sentence is why the composer refuses to send: the
					    request owns the agent's next line of input, and the server
					    refuses a message sent over it too. A disabled Send with no reason
					    on screen is the silent failure the project forbids. */}
					<span>
						Waiting for your permission. Answer above or Stop before sending.
					</span>
					{requestId && (
						<button
							type="button"
							onClick={() => onJumpToRequest(requestId)}
							className={STRIP_ACTION}
						>
							Jump to request
						</button>
					)}
				</div>
			</div>
		);
	}

	// Second: the questions the agent posted and carried on from. They are the
	// one thing on this strip with something for the user to *do* that is not
	// already on screen — and the row says nothing about sending, because
	// sending is not refused while a question is open. Row 1's second sentence
	// exists to explain a disabled Send; there is no disabled control here, so a
	// sentence would be inventing a restriction in order to explain it.
	//
	// At zero the row does not exist. No "nothing to answer", no empty frame —
	// and none held open for the panel either, which is why the panel being up
	// takes the row away rather than blanking it.
	if (unanswered > 0 && onAnswer && !answerPanelOpen) {
		return (
			<div className={STRIP_FRAME}>
				<div className={STRIP_LINE}>
					{/* Muted like the other three glyphs: `text-th-warning` on a glyph
					    is under the 3:1 non-text floor in every light variant
					    (docs/project-ui.md §3 holds the numbers), so a hue here would
					    say nothing in half the themes while costing the strip its one
					    vocabulary. The loud element is the button. */}
					<CircleHelp className="size-3 shrink-0" aria-hidden="true" />
					<span>
						{unanswered === 1
							? "1 question is waiting for your answer."
							: `${unanswered} questions are waiting for your answer.`}
					</span>
					{/* A button, not a link. Every other action on this strip is a way
					    to *look* at something and wears the underlined-text grammar;
					    this one is the action itself, and it is the entry point a user
					    is meant to find without hunting. Breaking the grammar once,
					    for the one row that is a call to action rather than a
					    statement, is what keeps the other three readable as
					    statements. */}
					<button
						type="button"
						onClick={onAnswer}
						className="touch-target rounded bg-th-accent px-2 py-0.5 text-th-accent-text transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						Answer
					</button>
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

export default AttentionStrip;
