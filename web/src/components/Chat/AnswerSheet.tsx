import { Sheet } from "@pockode/shared";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
	type AnswerEntry,
	buildAnswerMessage,
	toAnswerRecords,
} from "../../utils/answerMessage";
import QuestionForm from "./QuestionForm";

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
	 * echoed into, which draws each answer beside what was asked.
	 */
	onSend: (content: string, answering: QuestionAnswerRecord[]) => Promise<void>;
	onClose: () => void;
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
 */
function AnswerSheet({
	sessionId,
	unanswered,
	anchorRequestId,
	onSend,
	onClose,
}: Props) {
	const drafts = useQuestionDraftStore(selectSessionDrafts(sessionId));
	// Blocks that can no longer be answered but are still on screen, keyed by
	// request id. Held here rather than derived, because what they are is a fact
	// about this sheet's own history: the question was answerable when the sheet
	// last saw it, and the user has typed into it since. The question is kept
	// with the message — the list may no longer carry it, and then this is the
	// only copy left of what the user was answering.
	const [stale, setStale] = useState<Map<string, StaleBlock>>(new Map());
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// How many blocks the last submit carried, so the body can say so until the
	// next change. Zero means nothing has been sent from this sheet yet.
	const [sentCount, setSentCount] = useState(0);

	// Questions that were on screen last render, so a departure can be told from
	// a question that was never here.
	const seenRef = useRef<Map<string, PendingQuestion>>(new Map());

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

		// A question arriving makes the "N answers sent" line stale news — it
		// counted what was left at the time. A question *leaving* does not: the
		// blocks that were just submitted leave for that very reason, and
		// resetting on them would take the line away in the same frame it
		// appeared.
		if (arrived) setSentCount(0);
		if (departed.length === 0) return;

		const drafts = useQuestionDraftStore.getState().drafts[sessionId];
		const keep = departed.filter((q) => isDraftDirty(drafts?.[q.request_id]));
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
	// Scrolls the question the opener named into view, once. It never filters:
	// a sheet holding one of three open questions would be a second, partial
	// answer to "what is waiting on me".
	const anchoredRef = useRef(false);
	useEffect(() => {
		if (anchoredRef.current || !anchorRequestId) return;
		const target = bodyRef.current?.querySelector(
			`[data-answer-block="${CSS.escape(anchorRequestId)}"]`,
		);
		if (!target) return;
		anchoredRef.current = true;
		target.scrollIntoView({ block: "start" });
	}, [anchorRequestId]);

	const update = useCallback(
		(requestId: string, change: Partial<QuestionDraft>) => {
			const current =
				useQuestionDraftStore.getState().drafts[sessionId]?.[requestId] ??
				EMPTY_DRAFT;
			questionDraftActions.set(sessionId, requestId, { ...current, ...change });
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
					note: draft.note,
				};
			});
		if (entries.length === 0) return;

		setSending(true);
		setError(null);
		try {
			await onSend(buildAnswerMessage(entries), toAnswerRecords(entries));
			// Only now: a question whose send failed is still unanswered, and its
			// draft is the whole of what the user would have to retype.
			questionDraftActions.clear(
				sessionId,
				entries.map((e) => e.requestId),
			);
			setSentCount(entries.length);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(explain(message));
			// The refusal names every request id it refused over, so the blocks
			// that caused it go grey and keep their drafts while every other block
			// stays live — one more tap, nothing retyped (docs/answering-ui.md §7).
			const refused = liveBlocks.filter(
				(b) =>
					readyIds.includes(b.question.request_id) &&
					message.includes(b.question.request_id),
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
			setSending(false);
		}
	}, [liveBlocks, readyIds, drafts, onSend, sessionId]);

	// Closes only when the submit left nothing behind. Anything still open —
	// not submitted, or asked while the sheet was up — keeps it open, and a list
	// emptied from elsewhere never closes it: a sheet that vanishes under a
	// finger is worse than one that explains itself.
	useEffect(() => {
		if (sentCount > 0 && blocks.length === 0) onClose();
	}, [sentCount, blocks.length, onClose]);

	const title =
		unanswered.length === 1 ? "1 question" : `${unanswered.length} questions`;

	return (
		<Sheet
			title={title}
			onClose={onClose}
			dismissible={!sending}
			footer={
				<Footer
					ready={readyIds.length}
					total={liveBlocks.length}
					sending={sending}
					onSend={handleSend}
					onClose={onClose}
				/>
			}
		>
			<div ref={bodyRef} className="p-4 space-y-4">
				{sentCount > 0 && (
					<p className="text-xs text-th-text-muted">
						{sentCount === 1 ? "1 answer sent." : `${sentCount} answers sent.`}
					</p>
				)}
				{error && (
					<p role="alert" className="text-xs text-th-error">
						{error}
					</p>
				)}
				{blocks.length === 0 && (
					<p className="text-sm text-th-text-muted">Nothing left to answer.</p>
				)}
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
		</Sheet>
	);
}

function Footer({
	ready,
	total,
	sending,
	onSend,
	onClose,
}: {
	ready: number;
	total: number;
	sending: boolean;
	onSend: () => void;
	onClose: () => void;
}) {
	// Nothing left to answer turns the one button into the way out. There is no
	// Cancel beside Send at any other time: closing keeps every draft, and a
	// Cancel would promise that leaving discards.
	if (total === 0) {
		return (
			<button
				type="button"
				onClick={onClose}
				className="ml-auto min-h-[44px] rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text"
			>
				Close
			</button>
		);
	}
	return (
		<>
			<span className="self-center text-xs text-th-text-muted">
				{ready} of {total} ready
			</span>
			<button
				type="button"
				onClick={onSend}
				disabled={ready === 0 || sending}
				className="ml-auto min-h-[44px] rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text disabled:opacity-50"
			>
				{sending ? "Sending..." : "Send"}
			</button>
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
			// unpicks Other. The text it held is deliberately kept — the user can
			// change their mind back without retyping it, and it is not sent while
			// Other is unpicked.
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

	// One field, two controls: the **Other** input beside a set of options, and
	// the textarea of a question that offered none. `null` is what tells
	// QuestionForm the Other row is not in use, so an unpicked Other reads as
	// null however much text is parked behind it.
	const hasOpts = options.length > 0;
	const otherText = hasOpts
		? draft.otherPicked
			? draft.text
			: null
		: draft.text;

	return (
		<div
			data-answer-block={requestId}
			className={`rounded-lg border border-th-border p-3 ${stale ? "opacity-60" : ""}`}
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
			<fieldset disabled={locked} className="min-w-0">
				<QuestionForm
					question={{
						question: question.question,
						header: question.header,
						options,
						multiSelect,
					}}
					askedAt={question.asked_at}
					name={requestId}
					selection={{ labels: draft.labels, otherText }}
					disabled={locked}
					onSelectOption={handleOption}
					onSelectOther={handleOther}
					onOtherTextChange={(text) => onChange(requestId, { text })}
				/>
			</fieldset>

			{/* "Won't answer" rather than "Skip": skipping reads as *later*, and
			    this resolves the question for good. The line under it says who
			    finds out, which is the whole point of declining over ignoring —
			    it is the user's lever for a question the agent forgot to withdraw,
			    and because it travels as a message it wakes the agent up. */}
			<label className="mt-2 flex items-center gap-2 pointer-coarse:min-h-11 text-xs text-th-text-secondary">
				<input
					type="checkbox"
					checked={draft.declined}
					disabled={!!stale || disabled}
					onChange={() => onChange(requestId, { declined: !draft.declined })}
					className="accent-th-accent"
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
						className="w-full rounded border border-th-border bg-th-bg-primary px-2 py-1 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
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
 * turn, then send", about a card that is not in this sheet.
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

export default AnswerSheet;
