import {
	AlertTriangle,
	Check,
	CircleHelp,
	CornerDownRight,
	Hourglass,
	Lock,
	X,
} from "lucide-react";
import { type MouseEvent, useRef, useState } from "react";
import { toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type {
	PermissionRequest,
	PermissionStatus,
	SessionTurn,
	TurnBlocker,
} from "../../types/message";
import type { PromptError } from "./MessageItem";
import { Armed } from "./SendStopSlot";
import { Chip, Detail } from "./ToolRow";

/** A permission card the turn is blocked on, as the transcript has it now. */
export interface PermissionEntry {
	request: PermissionRequest;
	status: PermissionStatus;
}

/** No Always Allow: what it adds is spelled out on the card, and only there. */
export type StripPermissionChoice = "deny" | "allow";

interface Props {
	turn: SessionTurn;
	/** Scrolls the transcript to the card that is holding the turn up. */
	onJumpToRequest: (requestId: string) => void;
	/**
	 * The jump closes the answer panel on its way, so it stands down while the
	 * panel is sending, like the panel's own ways out (docs/answering-ui.md §2).
	 */
	jumpDisabled?: boolean;
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
	 * A typed message went into a turn that was already running and the agent has
	 * not reached it yet. The only receipt it gets for that stretch: the reply
	 * above keeps growing and nothing appears under the message, so without this
	 * line a message that landed and one that vanished look the same.
	 *
	 * It names a bounded state rather than the whole rest of the turn: the read
	 * point opens a bubble under the message the moment the agent picks it up,
	 * and that takes this line down. On Claude that moment is the send itself, so
	 * the line barely shows; on Codex it is however long the current step runs.
	 */
	sendPending?: boolean;
	/**
	 * The cards behind the turn's permission blockers, in the blockers' order,
	 * whatever their status — a card answered a moment ago is still here until
	 * the server takes its blocker down, and is what the row's receipt reads.
	 * A blocker whose card is not loaded has no entry.
	 */
	permissionRequests?: PermissionEntry[];
	/** The card's own answer path, so the strip and the card cannot drift. */
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: StripPermissionChoice,
	) => void;
	/** The last refused answer; shown on the row when it is the row's request. */
	promptError?: PromptError;
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

/**
 * Which card the permission row speaks for, and how many more are waiting.
 *
 * A denial still listed first: on Claude a deny interrupts the turn, so every
 * other request is about to expire, and handing the row to the next one would
 * offer answers the server can only refuse. The receipt holds until the
 * server says where the turn stands. Then the oldest pending one, the order
 * the server raised them in. With none pending, the one answered last, until
 * its blocker goes: the row holds still for that round trip as the press's
 * receipt instead of flashing another row.
 */
function permissionRowEntry(
	entries: PermissionEntry[],
): { entry: PermissionEntry; more: number } | undefined {
	const denied = entries.find((e) => e.status === "denied");
	if (denied) return { entry: denied, more: 0 };
	const pending = entries.filter((e) => e.status === "pending");
	if (pending.length > 0) {
		return { entry: pending[0], more: pending.length - 1 };
	}
	const answered = entries.findLast(
		(e) => e.status === "allowed" || e.status === "denied",
	);
	return answered && { entry: answered, more: 0 };
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

// Bounded like the transcript column above it; the frame's border stays full width.
const STRIP_LINE =
	"mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-1.5 px-3 py-2 text-th-text-muted text-xs";

// One bordered row above the composer, whichever of the four things it says.
const STRIP_FRAME = "shrink-0 border-th-border border-t";

// `touch-target` over a text line rather than a taller box: the strip's height
// is a statement's height, and growing it would push the composer down every
// time the agent asks something (docs/responsive-ui.md, hit areas). Written at
// module scope because that is the only helper shape the hit-area scan follows
// into a control (web/tests/touchTarget.ts, `interactiveControls`).
const STRIP_ACTION =
	"touch-target rounded px-1 underline transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";

// Left-aligned and 44px rather than the centred statement line: this row is a
// decision, read "what, then how", with the answers at the thumb's end. `py-2`
// around `h-7` controls is exactly the 44px `touch-target` reaches, so no
// control's hit area spills into the transcript or the composer.
const PERMISSION_LINE =
	"mx-auto flex max-w-3xl items-center gap-2 px-3 py-2 text-xs focus:outline-none";

// No `overflow-hidden` to contain a long title: it would clip `touch-target`'s
// overlay, so the title truncates itself instead.
const PERMISSION_SUMMARY =
	"touch-target flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:opacity-50";

const PERMISSION_DENY =
	"touch-target h-7 shrink-0 rounded-md border border-th-border px-3 text-th-text-primary transition-colors hover:bg-th-overlay-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";

const PERMISSION_ALLOW =
	"touch-target h-7 shrink-0 rounded-md bg-th-accent px-3 font-medium text-th-accent-text transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:opacity-50";

// The press keeps the caret where it is: in the answer panel's field on a
// short screen, moving it would bring the composer back under the thumb
// mid-press; in the composer, it would drop the keyboard a draft is being
// typed on. Approving needs neither moved.
const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * The permission row: the request, cut to one line the way its card's title
 * is, and the two answers that need nothing more than that line
 * (docs/lifecycle-ui.md §2.2).
 */
function PermissionRow({
	entry,
	more,
	error,
	onRespond,
	onJump,
	jumpDisabled,
}: {
	entry: PermissionEntry;
	more: number;
	error?: string;
	onRespond: (
		request: PermissionRequest,
		choice: StripPermissionChoice,
	) => void;
	onJump: (requestId: string) => void;
	jumpDisabled?: boolean;
}) {
	const workDir = useWSStore((state) => state.workDir);
	const { request, status } = entry;
	const summary = toolSummary(request.toolName, request.toolInput, workDir);
	const detail = summary.detail + summary.detailTail;
	const jump = () => onJump(request.requestId);
	// Approving a plan approves all the work after it, and one cut line is not
	// enough to decide that on: the primary answer becomes a way to the card.
	const isPlan = request.toolName === "ExitPlanMode";
	const summaryRef = useRef<HTMLButtonElement>(null);
	const groupRef = useRef<HTMLDivElement>(null);

	// The pressed button goes — to the receipt, or inert under the next
	// request — and focus would fall to the page with it. A pointer press never
	// focused it (`keepFocus`), so only a keyboard answer is carried over: to the
	// summary, or to the row itself while the summary is disabled mid-send.
	const respond = (
		e: MouseEvent<HTMLButtonElement>,
		choice: StripPermissionChoice,
	) => {
		const hadFocus = e.currentTarget === document.activeElement;
		onRespond(request, choice);
		if (!hadFocus) return;
		if (jumpDisabled) groupRef.current?.focus();
		else summaryRef.current?.focus();
	};

	const label = [
		"Show permission request:",
		summary.chip
			? `${summary.title} (${summary.chip}) ${detail}`
			: `${summary.title} ${detail}`,
		more > 0
			? `(${more} more permission request${more === 1 ? "" : "s"} waiting)`
			: "",
		error ? `— answer refused: ${error}` : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div className={STRIP_FRAME}>
			{/* biome-ignore lint/a11y/useSemanticElements: a fieldset's min-content width defeats the summary's truncation, and this is no form */}
			<div
				ref={groupRef}
				role="group"
				aria-label="Permission request"
				tabIndex={-1}
				className={PERMISSION_LINE}
			>
				<button
					ref={summaryRef}
					type="button"
					onClick={jump}
					disabled={jumpDisabled}
					title={error ?? detail}
					aria-label={label}
					className={PERMISSION_SUMMARY}
				>
					{error ? (
						<AlertTriangle
							className="size-3 shrink-0 text-th-error"
							aria-hidden="true"
						/>
					) : (
						<Lock
							className="size-3 shrink-0 text-th-text-muted"
							aria-hidden="true"
						/>
					)}
					{/* The title stays through a refusal: Allow is still live beside
					    it, and must not stand next to nothing but an error. */}
					<span className="max-w-[50%] shrink-0 truncate text-th-accent">
						{summary.title}
					</span>
					{summary.chip && <Chip>{summary.chip}</Chip>}
					{more > 0 && <Chip>{`+${more}`}</Chip>}
					{/* A refusal of an answer given here is said here, where the user
					    is looking, in the detail's place; the card holds the full
					    alert and the detail. */}
					{error ? (
						<span className="min-w-0 flex-1 truncate text-th-error">
							{error}
						</span>
					) : (
						<Detail
							detail={summary.detail}
							detailTail={summary.detailTail}
							mono={summary.mono}
						/>
					)}
				</button>
				{status === "pending" ? (
					// Keyed by request: answering one puts the next in the same
					// place, and a second tap must not approve what nobody read.
					<Armed key={request.requestId} className="gap-2">
						<button
							type="button"
							onMouseDown={keepFocus}
							onClick={(e) => respond(e, "deny")}
							className={PERMISSION_DENY}
						>
							Deny
						</button>
						{isPlan ? (
							<button
								type="button"
								onClick={jump}
								disabled={jumpDisabled}
								className={PERMISSION_ALLOW}
							>
								Review
							</button>
						) : (
							<button
								type="button"
								onMouseDown={keepFocus}
								onClick={(e) => respond(e, "allow")}
								className={PERMISSION_ALLOW}
							>
								Allow
							</button>
						)}
					</Armed>
				) : (
					<output className="flex shrink-0 items-center gap-1 text-th-text-muted">
						{status === "allowed" ? (
							<Check className="size-3" aria-hidden="true" />
						) : (
							<X className="size-3" aria-hidden="true" />
						)}
						{status === "allowed" ? "Allowed" : "Denied"}
					</output>
				)}
			</div>
		</div>
	);
}

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
 * transcript's *end*. The permission row alone departs from it, for the reason
 * `PERMISSION_LINE` gives: it is two decisions and their object, not a
 * statement.
 *
 * It holds no state of its own beyond whether the background detail is open:
 * everything it says is read from the session's turn and the transcript's tail,
 * and goes when they do.
 */
function AttentionStrip({
	turn,
	onJumpToRequest,
	jumpDisabled,
	onAnswer,
	answerPanelOpen,
	sendPending,
	permissionRequests,
	onPermissionRespond,
	promptError,
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
		const shown =
			onPermissionRespond && permissionRowEntry(permissionRequests ?? []);
		if (shown) {
			const { entry, more } = shown;
			return (
				<PermissionRow
					entry={entry}
					more={more}
					error={
						promptError?.requestId === entry.request.requestId &&
						entry.status === "pending"
							? promptError.message
							: undefined
					}
					onRespond={onPermissionRespond}
					onJump={onJumpToRequest}
					jumpDisabled={jumpDisabled}
				/>
			);
		}

		// The card is not in the loaded transcript yet — its event has not
		// arrived, or it sits in history not paged in — so there is nothing to
		// summarise or answer from here. The statement row stands in.
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
							disabled={jumpDisabled}
							className={`${STRIP_ACTION} disabled:opacity-50`}
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
						// The press keeps the caret where it is until the click. With
						// it in the composer on a short touch screen the panel has
						// stepped aside, and a press that moved focus would end that
						// and unmount this row before its own click arrived
						// (docs/answering-ui.md §3, "The converse").
						onMouseDown={(e) => e.preventDefault()}
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
					{/* Not "sent into the reply above" any more: the reply above is not
					    where this message is answered — once the agent reads it, a
					    bubble opens underneath it instead. What is left to say is the
					    only thing still invisible, that the agent has not got to it. */}
					<span>Sent — the agent has not read it yet.</span>
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
				<p className="mx-auto max-w-3xl px-3 pb-2 text-center text-th-text-muted text-xs">
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
