import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	EMPTY_DRAFT,
	isDraftDirty,
	isDraftReady,
	type QuestionDraft,
	questionDraftActions,
	selectSessionDrafts,
	useQuestionDraftStore,
} from "../../lib/questionDraftStore";
import type {
	PendingQuestion,
	QuestionAnswerRecord,
} from "../../types/message";
import { type AnswerEntry, toAnswerRecords } from "../../utils/answerRecords";
import {
	noteApplies,
	type QuestionSelection,
} from "../../utils/questionAnswer";
import ChoiceInput from "./ChoiceInput";
import QuestionForm, { answerFieldClass } from "./QuestionForm";

interface Props {
	sessionId: string;
	/** The session's unanswered questions, live: it arrives on the turn state. */
	unanswered: PendingQuestion[];
	/** Scrolled into view on open. Absent opens on the oldest question. */
	anchorRequestId?: string;
	/**
	 * Sends one message answering the blocks the user chose. Resolves on
	 * delivery and rejects with the server's own words, which is what tells
	 * "somebody else answered that one" apart from a dropped socket.
	 *
	 * It takes whole answer *records* rather than the wire's narrower params,
	 * because the same facts have a second reader: the bubble the message is
	 * echoed into, which draws each answer beside what was asked. There is no
	 * text beside them: the server writes what the agent reads.
	 */
	onSend: (answering: QuestionAnswerRecord[]) => Promise<void>;
	onClose: () => void;
	/**
	 * Whether the panel should read itself out. True when a user action named
	 * the question on screen, and when the panel's own arrival has just cost the
	 * document its focus — `ChatPanel` decides both. Most of the time it is
	 * neither: the panel is up because a question is waiting, and a panel that
	 * grabs the caret out of the composer somebody is typing in has stolen it
	 * (docs/answering-ui.md §4).
	 */
	takeFocus: boolean;
	/**
	 * Whether the user is working *inside* this card, which is the difference
	 * between a panel that is merely up and a panel the soft keyboard belongs to.
	 * Told to the host rather than kept here: what to fold away for the room is a
	 * fact about the screen around this card, not about the card
	 * (docs/answering-ui.md §3, "Room on a short viewport").
	 */
	onFocusChange?: (focused: boolean) => void;
	/**
	 * Whether a submit is in flight. Told to the host because one way out of
	 * this panel is not the panel's own — the strip's jump to a permission card
	 * closes it from outside — and it has to stand down mid-send like the rest.
	 */
	onSendingChange?: (sending: boolean) => void;
	/**
	 * Whether the host has folded its chrome away to make room for this card.
	 * The card takes that room in the same breath — the whole rectangle rather
	 * than 85% of it, and its header folded into a 53px footer — and it does so
	 * off this one flag rather than asking the screen itself, so the card can
	 * never be in its short-viewport shape while the chrome is still up, or the
	 * other way round (docs/answering-ui.md §3, "Room on a short viewport").
	 */
	chromeCollapsed?: boolean;
	/**
	 * Whether the card has stepped aside for the composer, which on a short touch
	 * screen is the other half of the fold above (docs/answering-ui.md §3, "Room
	 * on a short viewport"). Off the screen and out of reach, but still mounted
	 * and still open: the drafts, the receipt and the body's scroll position are
	 * all where the user left them when it comes back. Escape still closes it —
	 * pressed in the composer it means "put the questions away" either way.
	 */
	yielded?: boolean;
}

/** A block the user can still see, whether or not its question is still open. */
interface Block {
	question: PendingQuestion;
	/**
	 * Why this block can no longer be answered, in the words it says so in.
	 * Absent on a live one.
	 */
	stale?: string;
}

/** A block whose question has left the list, kept because it holds a draft. */
interface StaleBlock {
	question: PendingQuestion;
	message: string;
}

const ALREADY_ANSWERED = "Already answered elsewhere.";

/** What the user types into, as opposed to picks: the fields worth revealing. */
const TEXT_FIELD = 'textarea, input:not([type="checkbox"]):not([type="radio"])';

/** One line of the body's text (16px at a 1.5 line box) kept below the field. */
const REVEAL_MARGIN_PX = 24;

/**
 * The one surface that answers questions.
 *
 * It reads the session's unanswered list — state, arriving with the chat
 * subscription and updating live — and never the transcript, which is what
 * makes a question answerable whose card has not been paged in
 * (docs/answering-ui.md §3).
 *
 * One block per `request_id`, oldest first, in one flat scroll. Not a wizard: a
 * wizard hides how much is left, forbids answering out of order, and turns two
 * questions into four taps.
 *
 * It is a card centred in the transcript's rectangle over a backdrop that
 * dims it, at one shape and one size at every width: the height is what the
 * content needs, capped at 85% of the rectangle, so one short question is a
 * small card rather than a wall. The one exception is a short viewport with
 * the host's chrome folded away (`chromeCollapsed`), where the cap is the whole
 * rectangle and the header is folded into the footer — and its converse, the
 * caret in the composer, where the card is not on the screen at all
 * (`yielded`).
 *
 * The backdrop covers the transcript and nothing else. The session header
 * above it, and the strip, the session bar and the composer below it, stay
 * lit, reachable and usable — dimming those would make this a modal over the
 * whole app, and the composer in particular is where the user says something
 * the questions did not ask for.
 *
 * It is a modal over that one rectangle and borrows exactly the habits that
 * follow from a backdrop: dismiss on backdrop press, and Escape claimed for the
 * window (ChatPanel stands its interrupt down while this is up — pressing
 * Escape at a dimmed transcript must not end the agent's turn). It takes none
 * of the rest, because what is behind the backdrop is not the whole page: no
 * portal, no body scroll lock, no focus trap, and no `aria-modal`, which would
 * tell a screen reader that a composer it can still Tab into is not there.
 *
 * Positioning is `absolute` against the wrapper `ChatPanel` puts around the
 * list, and the cap is a percentage of it, so the card and the backdrop follow
 * a resize, a soft keyboard and an error bar appearing without this component
 * knowing any of them happened, and without measuring anybody's height.
 */
function AnswerPanel({
	sessionId,
	unanswered,
	anchorRequestId,
	onSend,
	onClose,
	takeFocus,
	onFocusChange,
	onSendingChange,
	chromeCollapsed = false,
	yielded = false,
}: Props) {
	const drafts = useQuestionDraftStore(selectSessionDrafts(sessionId));
	// Blocks that can no longer be answered but are still on screen, keyed by
	// request id. Held here rather than derived, because what they are is a fact
	// about this panel's own history: the question was answerable when the panel
	// last saw it, and the user has typed into it since. The question is kept
	// with the message — the list may no longer carry it, and then this is the
	// only copy left of what the user was answering.
	const [stale, setStale] = useState<Map<string, StaleBlock>>(new Map());
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// How many blocks the last submit carried. Zero means nothing has been sent
	// from this panel yet, which is also what keeps a list emptied from
	// elsewhere from closing it.
	const [sentCount, setSentCount] = useState(0);
	// Whether the footer says "N answers sent." in place of its ready count.
	// Apart from `sentCount` because it ends sooner: at the user's next change,
	// when the count is what they need again — and that change must not turn a
	// later emptying of the list into a reason to stay open.
	const [receiptShown, setReceiptShown] = useState(false);

	// Questions that were on screen last render, so a departure can be told from
	// a question that was never here.
	const seenRef = useRef<Map<string, PendingQuestion>>(new Map());
	// Request ids the submit in flight carries. The turn update resolving them
	// and the send's own response travel on different channels, in no promised
	// order, so a question can leave the list while its draft is still waiting
	// on the response that would clear it — and that departure is this panel's
	// own answer landing, not somebody else's.
	const inFlightRef = useRef<Set<string>>(new Set());

	// Blocks whose question left the list while holding a draft keep their place
	// and go grey; ones holding nothing simply disappear, because nothing was
	// lost and an announcement would be noise.
	//
	// In an effect rather than during render: it writes state derived from the
	// *previous* list, and the comparison is only meaningful once.
	//
	// The drafts are read out of the store rather than off `drafts` above, so
	// that a keystroke does not re-run a comparison that is only about which
	// questions arrived and left.
	useEffect(() => {
		const live = new Set(unanswered.map((q) => q.request_id));
		const seen = seenRef.current;
		const departed: PendingQuestion[] = [];
		for (const [id, question] of seen) {
			if (!live.has(id)) departed.push(question);
		}
		const arrived = unanswered.some((q) => !seen.has(q.request_id));
		seenRef.current = new Map(unanswered.map((q) => [q.request_id, q]));

		// A question arriving makes the "N answers sent" receipt stale news — it
		// counted what was left at the time. A question *leaving* does not: the
		// blocks that were just submitted leave for that very reason, and
		// resetting on them would take the receipt away in the same frame it
		// appeared.
		if (arrived) {
			setSentCount(0);
			setReceiptShown(false);
		}
		if (departed.length === 0) return;

		const drafts = useQuestionDraftStore.getState().drafts[sessionId];
		const keep = departed.filter(
			(q) =>
				!inFlightRef.current.has(q.request_id) &&
				isDraftDirty(drafts?.[q.request_id]),
		);
		if (keep.length === 0) return;
		setStale((prev) => {
			const next = new Map(prev);
			for (const question of keep) {
				if (!next.has(question.request_id)) {
					next.set(question.request_id, {
						question,
						message: ALREADY_ANSWERED,
					});
				}
			}
			return next;
		});
	}, [unanswered, sessionId]);

	// Live questions first, in the server's order, then the grey remains of ones
	// that have gone.
	//
	// The stale mark wins over the list, and that is the refusal case rather
	// than an edge: the server has just told this client the question is
	// resolved, and the turn update saying so has not arrived yet. Trusting the
	// list there would put a live form back over a block the user was told is
	// closed, and let them press Send on it again.
	const blocks: Block[] = [
		...unanswered.map((question) => ({
			question,
			stale: stale.get(question.request_id)?.message,
		})),
		...[...stale.values()].flatMap((entry) =>
			unanswered.some((q) => q.request_id === entry.question.request_id)
				? []
				: [{ question: entry.question, stale: entry.message }],
		),
	];

	const liveBlocks = blocks.filter((b) => !b.stale);
	const readyIds = liveBlocks
		.filter((b) =>
			isDraftReady(drafts[b.question.request_id], hasOptions(b.question)),
		)
		.map((b) => b.question.request_id);

	const bodyRef = useRef<HTMLDivElement>(null);
	// Scrolls the question the opener named into view, once per naming. It never
	// filters: a panel holding one of three open questions would be a second,
	// partial answer to "what is waiting on me".
	//
	// Once *per naming* rather than once per panel, because the panel now shows
	// itself and stays up for as long as a question does: a user who names a
	// second question from the work detail is asking to be taken to that one,
	// and a panel that had already scrolled for the first would sit still.
	const anchoredRef = useRef<string | null>(null);
	useEffect(() => {
		if (!anchorRequestId) {
			anchoredRef.current = null;
			return;
		}
		if (anchoredRef.current === anchorRequestId) return;
		const target = bodyRef.current?.querySelector(
			`[data-answer-block="${CSS.escape(anchorRequestId)}"]`,
		);
		if (!target) return;
		anchoredRef.current = anchorRequestId;
		target.scrollIntoView({ block: "start" });
	}, [anchorRequestId]);

	// Keeps the field being typed in on screen, with a line of what follows it.
	// Not left to the browser: it scrolls a focused field into view when focus
	// arrives, at best, and not when the soft keyboard then shortens the body
	// under it or when the field grows a line — and on a short viewport any one
	// of those puts the caret behind the footer.
	useEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		const typingIn = (): HTMLElement | null => {
			const el = document.activeElement;
			return el instanceof HTMLElement &&
				body.contains(el) &&
				el.matches(TEXT_FIELD)
				? el
				: null;
		};
		const reveal = () => {
			const field = typingIn();
			if (!field) return;
			const view = body.getBoundingClientRect();
			const box = field.getBoundingClientRect();
			// The bottom first: a field taller than the body is typed into at its
			// end, so that is the half to keep.
			const below = box.bottom + REVEAL_MARGIN_PX - view.bottom;
			const above = view.top - (box.top - REVEAL_MARGIN_PX);
			if (below > 0) body.scrollTop += below;
			else if (above > 0) body.scrollTop -= Math.min(above, -below);
		};
		const observer = new ResizeObserver(reveal);
		observer.observe(body);
		const handleFocusIn = (e: FocusEvent) => {
			if (!(e.target instanceof HTMLElement) || !e.target.matches(TEXT_FIELD))
				return;
			observer.observe(e.target);
			reveal();
		};
		const handleFocusOut = (e: FocusEvent) => {
			if (e.target instanceof HTMLElement && e.target !== body) {
				observer.unobserve(e.target);
			}
		};
		body.addEventListener("focusin", handleFocusIn);
		body.addEventListener("focusout", handleFocusOut);
		return () => {
			observer.disconnect();
			body.removeEventListener("focusin", handleFocusIn);
			body.removeEventListener("focusout", handleFocusOut);
		};
	}, []);

	const update = useCallback(
		(requestId: string, change: Partial<QuestionDraft>) => {
			const current =
				useQuestionDraftStore.getState().drafts[sessionId]?.[requestId] ??
				EMPTY_DRAFT;
			questionDraftActions.set(sessionId, requestId, { ...current, ...change });
			setReceiptShown(false);
		},
		[sessionId],
	);

	const dismiss = useCallback(
		(requestId: string) => {
			questionDraftActions.clear(sessionId, [requestId]);
			setStale((prev) => {
				const next = new Map(prev);
				next.delete(requestId);
				return next;
			});
			setReceiptShown(false);
		},
		[sessionId],
	);

	const handleSend = useCallback(async () => {
		const entries: AnswerEntry[] = liveBlocks
			.filter((b) => readyIds.includes(b.question.request_id))
			.map((b) => {
				const draft = drafts[b.question.request_id] ?? EMPTY_DRAFT;
				return {
					requestId: b.question.request_id,
					header: b.question.header,
					question: b.question.question,
					...answersOf(b.question, draft),
					declined: draft.declined,
					note: noteOf(b.question, draft),
				};
			});
		if (entries.length === 0) return;

		setSending(true);
		setError(null);
		// A receipt left from an earlier submit would sit beside this one's error.
		setReceiptShown(false);
		inFlightRef.current = new Set(entries.map((e) => e.requestId));
		try {
			await onSend(toAnswerRecords(entries));
			// Only now: a question whose send failed is still unanswered, and its
			// draft is the whole of what the user would have to retype.
			questionDraftActions.clear(
				sessionId,
				entries.map((e) => e.requestId),
			);
			setSentCount(entries.length);
			setReceiptShown(true);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(explain(message));
			// The refusal names every request id it refused over, so the blocks
			// that caused it go grey and keep their drafts while every other block
			// stays live — one more tap, nothing retyped (docs/answering-ui.md §7).
			//
			// So does one that left the list while the send was out: the departure
			// was held back as possibly this panel's own, and the send failing says
			// it was not. Left alone it would vanish with its draft still stored.
			const refused = liveBlocks.filter(
				(b) =>
					readyIds.includes(b.question.request_id) &&
					(message.includes(b.question.request_id) ||
						!seenRef.current.has(b.question.request_id)),
			);
			if (refused.length > 0) {
				setStale((prev) => {
					const next = new Map(prev);
					for (const b of refused) {
						next.set(b.question.request_id, {
							question: b.question,
							message: ALREADY_ANSWERED,
						});
					}
					return next;
				});
			}
		} finally {
			inFlightRef.current = new Set();
			setSending(false);
		}
	}, [liveBlocks, readyIds, drafts, onSend, sessionId]);

	// Closes only when the submit left nothing behind. Anything still open —
	// not submitted, or asked while the panel was up — keeps it open, and a list
	// emptied from elsewhere never closes it: a panel that vanishes under a
	// finger is worse than one that explains itself.
	//
	// Never mid-send: the list can empty before the response lands, and
	// `sentCount` may still be counting an earlier submit, so closing then would
	// take the panel away before this submit is known to have gone out.
	useEffect(() => {
		if (!sending && sentCount > 0 && blocks.length === 0) onClose();
	}, [sending, sentCount, blocks.length, onClose]);

	const title =
		unanswered.length === 1 ? "1 question" : `${unanswered.length} questions`;

	const titleId = useId();
	const rootRef = useRef<HTMLElement>(null);

	// On the edge where a user action asks for this panel, not while one holds.
	// The edge and not the mount, because the panel now shows itself the moment
	// a question arrives: by the time the work detail's `Answer` names one, the
	// panel it names is usually already up, and a mount-only read would leave
	// that entry point silent. Holding `takeFocus` true across re-renders takes
	// nothing, so no re-render can pull the caret out of a field being typed in.
	// `preventScroll` so nothing behind the panel moves; the panel itself is
	// what is read out, its title first.
	const tookFocusRef = useRef(false);
	useEffect(() => {
		if (takeFocus && !tookFocusRef.current) {
			rootRef.current?.focus({ preventScroll: true });
		}
		tookFocusRef.current = takeFocus;
	}, [takeFocus]);

	// Closing on Escape, backdrop, × and the footer's Close is one action under
	// four names, and all four stand down mid-send: a slow relay must not leave
	// the user unsure whether their answers went out. The strip's jump, which
	// closes from outside, stands down on `onSendingChange` below.
	const handleDismiss = useCallback(() => {
		if (sending) return;
		onClose();
	}, [sending, onClose]);

	// The cleanup is what reports the end, so a panel unmounted mid-send — an
	// overlay opening, a session switch — cannot leave the host thinking a send
	// is still out.
	useEffect(() => {
		if (!sending) return;
		onSendingChange?.(true);
		return () => onSendingChange?.(false);
	}, [sending, onSendingChange]);

	// Escape closes the panel rather than interrupting the agent's turn, and it
	// is claimed for the window rather than on the panel's own element: the
	// panel shows itself without taking focus, so the press usually lands on the
	// composer or on nothing at all. `ChatPanel` counts this panel among the
	// surfaces that own the key and stands its interrupt down for as long as it
	// is up — which is the point of moving the key here. A user pressing Escape
	// at a dimmed transcript means "put this away"; reading it as an interrupt
	// would end the turn, and that cannot be taken back, while the mistake in
	// this direction costs one more press.
	//
	// On `window` and not on `document`, so that this is the *last* surface
	// asked. Anything drawn over this panel dismisses on a document listener of
	// its own — the session-info panel the lit header opens is the one that can
	// really be over it — and those listeners are registered after this one, so
	// asking `defaultPrevented` at the document would ask it before they have
	// run and put two surfaces away with one press. `window` is past every one
	// of them in the bubble path, whatever order they were added in.
	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			handleDismiss();
		};
		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	}, [handleDismiss]);

	// The backdrop press is read on `window` for the same reason Escape is, and
	// it is the same press: the header's dropdowns above the expanded tier and
	// the composer's command palette at every width are anchored to their
	// triggers with no backdrop of their own, so dismissing one is a click on
	// the dimmed transcript — this backdrop. Those dismissals run on `document`
	// and claim the click, which only takes it off the path if this panel is
	// asked afterwards; a React `onClick` here would be asked *first*, React 19
	// delegating to the root container, and one press would put away both.
	//
	// Comparing against the backdrop element rather than asking whether the
	// target is outside the card keeps the press that starts on a question's
	// text and ends past the edge — selecting it by dragging — from dismissing:
	// `click` then fires on the common ancestor, which is the container, not
	// this. `Sheet` separates the layers for the same reason.
	const backdropRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const handleClick = (e: MouseEvent) => {
			if (e.target !== backdropRef.current) return;
			handleDismiss();
		};
		window.addEventListener("click", handleClick);
		return () => window.removeEventListener("click", handleClick);
	}, [handleDismiss]);

	return (
		// `absolute inset-0` against ChatPanel's wrapper, so this covers the
		// transcript and stops at its edges. `z-10` is enough: the list below
		// stacks nothing higher than z-3 (an open row's bar, and the scroll
		// button kept over it), and the portalled sheets — z-50, z-70 —
		// still come out over this one.
		//
		// A yield is `invisible` + `inert`, the transcript's own way of leaving
		// the screen under an overlay, and for its reason: `display: none` or an
		// unmount would throw the body's scroll position away. Hidden, the
		// backdrop is no target either, so no press can dismiss a card nobody
		// can see.
		<div
			inert={yielded}
			className={`absolute inset-0 z-10 flex items-center justify-center${yielded ? " invisible" : ""}`}
		>
			{/* The backdrop is its own layer under the card, not a handler on
			    this container: what it dims is exactly what a press on it puts
			    away. The press itself is read on `window` above. */}
			<div
				ref={backdropRef}
				data-testid="answer-panel-backdrop"
				className="absolute inset-0 bg-th-bg-overlay"
				aria-hidden="true"
			/>
			{/* `role="dialog"` without `aria-modal`: this is modal over the
			    transcript alone, and `aria-modal` would hide the composer, the
			    strip and the header from a screen reader that can still reach all
			    three. outline-none: it takes focus only to announce itself. */}
			<section
				ref={rootRef}
				role="dialog"
				tabIndex={-1}
				aria-labelledby={titleId}
				// React's focus events bubble, so the card itself hears every control
				// in it — including its own `tabIndex={-1}`, which is what it takes
				// when it reads itself out. `relatedTarget` is what keeps a move
				// between two controls from reading as a departure: without it,
				// tabbing from an option to Send would report the card as left and
				// then entered again.
				onFocus={() => onFocusChange?.(true)}
				onBlur={(e) => {
					if (e.currentTarget.contains(e.relatedTarget)) return;
					onFocusChange?.(false);
				}}
				// Centred, capped at a share of the rectangle rather than at a
				// number of pixels: a percentage needs no font size, no row height
				// and no measurement of anything to stay inside the transcript, and
				// it goes on doing so when the soft keyboard halves the screen. No
				// `h-full`, so a single short question is a small card rather than a
				// wall. The rounding, shadow and colour are `Sheet`'s own centred
				// values; its drag handle is not copied, there being nothing to drag
				// here. The width is not `Sheet`'s: that holds pickers and short forms,
				// this holds prose and code, so the cap is a reading measure, with
				// no breakpoint prefix (docs/answering-ui.md §3, "One shape at every
				// width").
				//
				// With the chrome folded the cap is the whole rectangle: at that
				// height every row of the margin is a row of the question being
				// typed in, and the folded chrome is what the user would look at
				// past the edges anyway.
				className={`relative mx-4 flex ${chromeCollapsed ? "max-h-full" : "max-h-[85%]"} w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-th-bg-secondary shadow-xl outline-none`}
			>
				{/* Header, footer and the close button wear the same classes as
				    `Sheet`'s, copied rather than shared: what makes them look alike
				    is the tokens, and a `variant` on a shared modal would make every
				    reader of `Sheet` — in both frontends — check which half they are
				    in first.

				    Folded chrome folds the header into the footer: the title's count
				    is the footer's "N of M ready" said a second time, and its row is
				    a third of the body at that height — the room the field being
				    typed in and a line either side of it need. The title stays for a
				    screen reader, which names the dialog by it. */}
				{chromeCollapsed ? (
					<h2 id={titleId} className="sr-only">
						{title}
					</h2>
				) : (
					<div className="flex shrink-0 items-center justify-between border-b border-th-border px-4 py-3">
						<h2
							id={titleId}
							className="min-w-0 truncate text-base font-bold text-th-text-primary"
						>
							{title}
						</h2>
						<CloseButton
							onClick={handleDismiss}
							disabled={sending}
							className="-my-1.5 -mr-1"
						/>
					</div>
				)}
				{/* overscroll-y-contain: an overscroll at either end stops here
				    rather than leaving the panel — on touch that is the browser's own
				    rubber-band and pull-to-refresh, reached by flicking through the
				    last question. The transcript's scroller carries the same class
				    for the same reason; it is a sibling of this one, not an ancestor,
				    so chaining could never have reached it. */}
				<div
					ref={bodyRef}
					className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-4 space-y-4"
				>
					{error && (
						<p role="alert" className="text-xs text-th-error">
							{error}
						</p>
					)}
					{blocks.length === 0 && (
						<p className="text-sm text-th-text-muted">
							Nothing left to answer.
						</p>
					)}
					{/* The questions sit on the card itself, a rule between two: a box
					    around each would be a third border around every option, and
					    the margins it takes are the question's own room on a phone.
					    The options keep theirs, being what is pressed. */}
					<div className="divide-y divide-th-border">
						{blocks.map((block) => (
							<QuestionBlock
								key={block.question.request_id}
								block={block}
								draft={drafts[block.question.request_id] ?? EMPTY_DRAFT}
								disabled={sending}
								onChange={update}
								onDismiss={dismiss}
							/>
						))}
					</div>
				</div>
				{/* Folded, the footer is Send's 44px and a 4px edge. The close button
				    goes to the far end from Send, so a thumb reaching for one does not
				    land on the other; with nothing left to answer, Send is already
				    Close. */}
				<div
					className={`flex shrink-0 gap-3 border-t border-th-border px-4 ${chromeCollapsed ? "py-1" : "py-4"}`}
				>
					{chromeCollapsed && liveBlocks.length > 0 && (
						<CloseButton
							onClick={handleDismiss}
							disabled={sending}
							className="-ml-1 self-center"
						/>
					)}
					<Footer
						receipt={
							!receiptShown
								? null
								: sentCount === 1
									? "1 answer sent."
									: `${sentCount} answers sent.`
						}
						ready={readyIds.length}
						total={liveBlocks.length}
						sending={sending}
						onSend={handleSend}
						onClose={handleDismiss}
					/>
				</div>
			</section>
		</div>
	);
}

/** Its 36px box reaches 44px through `touch-target`, under a thumb. */
function CloseButton({
	onClick,
	disabled,
	className,
}: {
	onClick: () => void;
	disabled: boolean;
	/** Where it sits in its row. */
	className: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label="Close"
			className={`touch-target flex size-9 shrink-0 items-center justify-center rounded text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
		>
			<X className="size-5" />
		</button>
	);
}

function Footer({
	receipt,
	ready,
	total,
	sending,
	onSend,
	onClose,
}: {
	receipt: string | null;
	ready: number;
	total: number;
	sending: boolean;
	onSend: () => void;
	onClose: () => void;
}) {
	// Nothing left to answer turns the one button into the way out. There is no
	// Cancel beside Send at any other time: closing keeps every draft, and a
	// Cancel would promise that leaving discards.
	//
	// It can appear mid-send — the blocks being sent leave the list as soon as
	// the turn update says they are resolved, which may be before the response —
	// so it stands down with the others, and says why, until the send is known
	// to have landed.
	//
	// The receipt of a partial submit takes the ready count's place, because the
	// footer is the one row always on screen: the body stays where the user was
	// reading (§7, "Nothing scrolls"), and its top is usually out of view. Its
	// live region is on screen before the text arrives — one mounted with its
	// text already in is not announced — and holds only the receipt, so the
	// count ticking with every pick is not read out.
	return (
		<>
			<span className="self-center text-xs text-th-text-muted">
				<output>{receipt}</output>
				{!receipt && total > 0 && `${ready} of ${total} ready`}
			</span>
			{total === 0 ? (
				<button
					type="button"
					onClick={onClose}
					disabled={sending}
					className="ml-auto min-h-[44px] rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text disabled:opacity-50"
				>
					{sending ? "Sending..." : "Close"}
				</button>
			) : (
				<button
					type="button"
					onClick={onSend}
					disabled={ready === 0 || sending}
					className="ml-auto min-h-[44px] rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text disabled:opacity-50"
				>
					{sending ? "Sending..." : "Send"}
				</button>
			)}
		</>
	);
}

function QuestionBlock({
	block,
	draft,
	disabled,
	onChange,
	onDismiss,
}: {
	block: Block;
	draft: QuestionDraft;
	disabled: boolean;
	onChange: (requestId: string, change: Partial<QuestionDraft>) => void;
	onDismiss: (requestId: string) => void;
}) {
	const { question, stale } = block;
	const requestId = question.request_id;
	const options = question.options ?? [];
	const multiSelect = question.multi_select ?? false;
	const locked = !!stale || disabled || draft.declined;

	const handleOption = (label: string) => {
		if (!multiSelect) {
			// Radios are exclusive, and **Other** is one of them: picking a label
			// unpicks Other. The text it held is deliberately kept, and stays on
			// screen — the user can change their mind back without retyping it, and
			// it is not sent while Other is unpicked.
			onChange(requestId, { labels: [label], otherPicked: false });
			return;
		}
		onChange(requestId, {
			labels: draft.labels.includes(label)
				? draft.labels.filter((l) => l !== label)
				: [...draft.labels, label],
		});
	};

	const handleOther = () => {
		if (!multiSelect) {
			onChange(requestId, { labels: [], otherPicked: true });
			return;
		}
		onChange(requestId, { otherPicked: !draft.otherPicked });
	};

	return (
		<div
			data-answer-block={requestId}
			className={`py-4 first:pt-0 last:pb-0 ${stale ? "opacity-60" : ""}`}
		>
			{stale && (
				<div className="mb-2 flex items-start gap-2 text-xs text-th-text-muted">
					<span className="min-w-0 flex-1">{stale}</span>
					<button
						type="button"
						onClick={() => onDismiss(requestId)}
						aria-label="Dismiss this question"
						className="touch-target -m-1 flex size-5 shrink-0 items-center justify-center rounded hover:text-th-text-primary"
					>
						<X className="size-3.5" />
					</button>
				</div>
			)}
			{/* A declined block dims as a whole, question and header included, and
			    its picks are drawn as kept-not-sent. Won't answer and its note
			    stay lit: they are what the user acts on now. */}
			<div className={draft.declined && !stale ? "opacity-60" : ""}>
				<QuestionForm
					question={{
						question: question.question,
						header: question.header,
						options,
						multiSelect,
					}}
					askedAt={question.asked_at}
					name={requestId}
					selection={selectionOf(question, draft)}
					disabled={locked}
					withheld={draft.declined}
					onSelectOption={handleOption}
					onSelectOther={handleOther}
					onOtherTextChange={(text) => onChange(requestId, { text })}
					otherInput={draft.text}
					note={draft.answerNote}
					onNoteChange={(answerNote) => onChange(requestId, { answerNote })}
				/>
			</div>

			{/* "Won't answer" rather than "Skip": skipping reads as *later*, and
			    this resolves the question for good. The line under it says who
			    finds out, which is the whole point of declining over ignoring —
			    it is the user's lever for a question the agent forgot to withdraw,
			    and because it travels as a message it wakes the agent up. */}
			<label className="mt-2 flex items-center gap-2 pointer-coarse:min-h-11 text-xs text-th-text-secondary">
				<ChoiceInput
					type="checkbox"
					tone={stale || disabled ? "withheld" : "actionable"}
					checked={draft.declined}
					disabled={!!stale || disabled}
					onChange={() => onChange(requestId, { declined: !draft.declined })}
				/>
				Won&apos;t answer
			</label>
			{draft.declined && (
				<div className="mt-1 space-y-1">
					<p className="text-xs text-th-text-muted">
						The agent will be told you are not answering this.
					</p>
					<input
						type="text"
						value={draft.note}
						disabled={!!stale || disabled}
						onChange={(e) => onChange(requestId, { note: e.target.value })}
						placeholder="Add a note (optional)"
						className={`w-full text-th-text-primary ${answerFieldClass}`}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * The server's reason, or the one refusal worth restating.
 *
 * A session blocked on a permission request reads nothing else — the CLI is
 * holding that request open — so the answer message cannot be delivered at all.
 * The server says so in its own terms; what the user needs is where to go, and
 * that is the row above the composer, which the strip already ranks first.
 */
/**
 * The fragment of `chat.ErrTurnAwaitingAnswer` this recognises the refusal by.
 *
 * A sentence matched across the wire, so it is named here and checked against
 * the server's own text by `web/tests/serverRefusalCopy.test.ts`: reword the Go
 * error and this stops matching, and what the user would then be shown is the
 * half of that sentence written for somebody else — "answer it, or stop the
 * turn, then send", about a card that is not in this panel.
 */
export const TURN_AWAITING_ANSWER_MARKER =
	"waiting for an answer to the request on screen";

function explain(message: string): string {
	if (message.includes(TURN_AWAITING_ANSWER_MARKER)) {
		return "The agent is waiting for a permission decision. Answer that first.";
	}
	return message;
}

function hasOptions(question: PendingQuestion): boolean {
	return (question.options ?? []).length > 0;
}

/**
 * What the user's draft answers, split the way the record keeps it: option labels
 * on one side, their own words on the other.
 *
 * A question with no options has no labels to give, so its whole answer is the
 * text. Beside options, the text only counts while **Other** is picked — the
 * store keeps what was typed after it is unpicked, and sending that would answer
 * with something the user has taken back.
 */
function answersOf(
	question: PendingQuestion,
	draft: QuestionDraft,
): { answers: string[]; text?: string } {
	if (!hasOptions(question)) return { answers: [], text: draft.text };
	return {
		answers: draft.labels,
		...(draft.otherPicked ? { text: draft.text } : {}),
	};
}

/**
 * The draft as the form draws it. One field, two controls: the **Other** input
 * beside a set of options, and the textarea of a question that offered none.
 * `null` is what tells QuestionForm the Other row is not in use, so an unpicked
 * Other reads as null however much text is parked behind it.
 */
function selectionOf(
	question: PendingQuestion,
	draft: QuestionDraft,
): QuestionSelection {
	if (!hasOptions(question)) return { labels: [], otherText: draft.text };
	return {
		labels: draft.labels,
		otherText: draft.otherPicked ? draft.text : null,
	};
}

/**
 * Which of the draft's two notes goes out, if either: the decline's beside a
 * decline, and the remark only while there is something picked for it to sit
 * beside — the same rule that has the form show it as parked otherwise.
 */
function noteOf(
	question: PendingQuestion,
	draft: QuestionDraft,
): string | undefined {
	if (draft.declined) return draft.note;
	const applies = noteApplies(
		{
			options: question.options ?? [],
			multiSelect: question.multi_select ?? false,
		},
		selectionOf(question, draft),
	);
	return applies ? draft.answerNote : undefined;
}

export default AnswerPanel;
