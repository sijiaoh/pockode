import { CircleHelp, Hourglass, Lock } from "lucide-react";
import { useState } from "react";
import type { SessionTurn, TurnBlocker } from "../../types/message";

interface Props {
	turn: SessionTurn;
	/** Scrolls the transcript to the card that is holding the turn up. */
	onJumpToRequest: (requestId: string) => void;
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

/**
 * One line between the transcript and the composer, saying why the agent is
 * quiet (docs/lifecycle-ui.md §2.2).
 *
 * It borrows `ForkOriginBanner`'s chrome — centred, `text-xs`, `size-3` glyph,
 * muted — because both are one-line statements about the transcript rather than
 * controls, and the pane should have one vocabulary for them. It sits below the
 * list, where the fork banner sits above it, because it describes the
 * transcript's *end*.
 *
 * It holds no state of its own beyond whether the background detail is open: it
 * describes the session's current blocker and disappears with it.
 */
const STRIP_LINE =
	"flex flex-wrap items-center justify-center gap-1.5 px-3 py-2 text-th-text-muted text-xs";

// `touch-target` over a text line rather than a taller box: the strip's height
// is a statement's height, and growing it would push the composer down every
// time the agent asks something (docs/responsive-ui.md, hit areas). Written at
// module scope because that is the only helper shape the hit-area scan follows
// into a control (web/tests/touchTarget.ts, `interactiveControls`).
const STRIP_ACTION =
	"touch-target rounded px-1 underline transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";

function BlockerStrip({ turn, onJumpToRequest }: Props) {
	const [expanded, setExpanded] = useState(false);

	const blocker =
		turn.phase === "blocked" ? leadingBlocker(turn.blockers ?? []) : undefined;
	if (!blocker) return null;

	if (blocker.kind === "background") {
		const since = formatSince(turn.since);
		return (
			<div className="shrink-0 border-th-border border-t">
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
				{/* Two things a user who has waited an hour needs told before they
				    reach for Stop: nothing is stuck, and Stop is the only lever —
				    there is no per-task kill, because the model gives the host no way
				    to end one task without ending the turn. */}
				{expanded && (
					<p className="px-3 pb-2 text-center text-th-text-muted text-xs">
						{since
							? `Waiting on background tasks since ${since}. `
							: "Waiting on background tasks. "}
						The agent resumes on its own when they finish. Stopping ends the
						turn and loses the tasks.
					</p>
				)}
			</div>
		);
	}

	const isQuestion = blocker.kind === "question";
	const Icon = isQuestion ? CircleHelp : Lock;

	return (
		<div className="shrink-0 border-th-border border-t">
			<div className={STRIP_LINE}>
				<Icon className="size-3 shrink-0" aria-hidden="true" />
				<span>
					{isQuestion
						? "Waiting for your answer."
						: "Waiting for your permission."}
				</span>
				{/* The pill counts questions you cannot see; this states why the agent
				    is quiet. Both on screen at once is correct, and neither
				    reimplements the jump. */}
				{blocker.request_id && (
					<button
						type="button"
						onClick={() => {
							if (blocker.request_id) onJumpToRequest(blocker.request_id);
						}}
						className={STRIP_ACTION}
					>
						{isQuestion ? "Jump to question" : "Jump to request"}
					</button>
				)}
			</div>
		</div>
	);
}

export default BlockerStrip;
