import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * What the user has put into one question's block, before it is sent.
 *
 * `labels` and `text` are the two halves of an answer and may both carry
 * something: `labels` holds options the question offered, `text` holds the
 * user's own words — the whole answer to a question that offered no options, or
 * the **Other** beside ones it did. The server checks labels against the
 * question and never checks the text, because a label it never offered would be
 * its own word handed back to it while the text is simply what the user said.
 *
 * **Other** and **Won't answer** are not alternatives. Other is "my answer is
 * something else"; declining is "I am not answering this". Recording the first
 * as the second would tell the agent the user refused, and throw away the most
 * useful sentence on the screen (docs/answering-ui.md §3).
 */
export interface QuestionDraft {
	/** The option labels ticked. Empty for a question that offered none. */
	labels: string[];
	/**
	 * The user's own words. One field for two controls — the **Other** input
	 * beside a set of options, and the textarea of a question that offered none —
	 * because a question only ever has one of the two.
	 */
	text: string;
	/**
	 * Whether **Other** is picked, for a question that offered options.
	 *
	 * Stored rather than derived from `text` being non-empty: the input has to be
	 * on screen *before* there is anything in it, and "ticked but still empty" is
	 * a real state — one that is not a complete answer.
	 */
	otherPicked: boolean;
	declined: boolean;
	/** The optional line beside a decline. */
	note: string;
}

export const EMPTY_DRAFT: QuestionDraft = {
	labels: [],
	text: "",
	otherPicked: false,
	declined: false,
	note: "",
};

interface QuestionDraftState {
	/** `sessionId` → `request_id` → what was typed. */
	drafts: Record<string, Record<string, QuestionDraft>>;
	/**
	 * What came back out of storage and has not been vouched for yet, in the
	 * same shape. A draft sits here until its session's unanswered list arrives:
	 * the list is the only thing that can say whether the question it answers is
	 * still open, and nothing may go on screen before it does.
	 *
	 * A session is in one of the two maps, never both: `restore` empties its
	 * entry here as it fills the other. Nothing writes to `drafts` for a session
	 * still waiting, because writing means typing into a block, and a block only
	 * exists once the list it came from has arrived.
	 */
	restorable: Record<string, Record<string, QuestionDraft>>;
}

/** Where the drafts live, beside the composer's own (`input_drafts`). */
const STORAGE_KEY = "question_drafts";

/**
 * Everything that belongs in storage: the vouched-for drafts, plus the ones
 * still waiting to be checked, exactly as they came out.
 *
 * The waiting half has to be written back too. Storage holds every session at
 * once and is rewritten whole on each change, so leaving out the sessions this
 * page has not opened would make typing in one session delete the drafts of all
 * the others.
 *
 * A session left holding nothing is dropped instead of stored empty: every
 * session ever answered in passes through here, and an empty entry each would
 * grow without ever being read.
 */
function toStorage(
	state: QuestionDraftState,
): Record<string, Record<string, QuestionDraft>> {
	const sessions = { ...state.restorable };
	for (const [sessionId, session] of Object.entries(state.drafts)) {
		const merged = { ...sessions[sessionId], ...session };
		if (Object.keys(merged).length === 0) delete sessions[sessionId];
		else sessions[sessionId] = merged;
	}
	return sessions;
}

export const useQuestionDraftStore = create<QuestionDraftState>()(
	persist(
		() => ({
			drafts: {},
			restorable: {},
		}),
		{
			name: STORAGE_KEY,
			partialize: (state) => ({ drafts: toStorage(state) }),
			// What was stored is held back in `restorable` rather than restored
			// outright: see `restore`.
			merge: (persisted, current) => ({
				...current,
				restorable:
					(persisted as Partial<QuestionDraftState> | undefined)?.drafts ?? {},
			}),
		},
	),
);

/**
 * The drafts of one session's answer panel.
 *
 * A store rather than component state because every host of a draft unmounts
 * under the user: the panel closes, the panel is not drawn at all while an
 * overlay is up — an overlay covers the transcript but takes the place of
 * everything else in the pane — and the user switches sessions and comes back.
 * Component state loses the draft to all three.
 *
 * It is persisted to `localStorage`, so a reload keeps what was typed, and the
 * question a draft answers is checked before any of it is shown again — see
 * `restore`. That check is what makes persisting safe: the danger was never the
 * storage, it was putting an answer back on screen for a question withdrawn two
 * days ago.
 *
 * Two things clear one, and both are the user's own act: its submit succeeding,
 * and the user dismissing a block whose question something else has already
 * resolved. Nothing clears a draft behind their back — deleting text somebody
 * typed without showing it to them first is the failure this store exists to
 * prevent (docs/answering-ui.md §5).
 */
export const questionDraftActions = {
	/**
	 * Hands a session's stored drafts to its unanswered list to be vouched for,
	 * once, on the list's first arrival.
	 *
	 * A draft is put back only if that list still carries its `request_id`;
	 * every other one is dropped, storage included, and silently — the block it
	 * belonged to is not on screen and never will be, so there is nothing to
	 * tell the user about and nothing they could do. This is what keeps the old
	 * promise: text is only ever deleted out of sight of the person who typed it
	 * when they can no longer see the question either (docs/answering-ui.md §5).
	 *
	 * Drafts typed since the page loaded win over the stored copy and are never
	 * dropped here, whatever the list says: their block may be on screen right
	 * now, grey and holding an answer the user is still looking at.
	 */
	restore(sessionId: string, liveRequestIds: string[]): void {
		useQuestionDraftStore.setState((state) => {
			const waiting = state.restorable[sessionId];
			if (!waiting) return state;
			const live = new Set(liveRequestIds);
			const vouched: Record<string, QuestionDraft> = {};
			for (const [requestId, draft] of Object.entries(waiting)) {
				if (live.has(requestId)) vouched[requestId] = draft;
			}
			const { [sessionId]: _checked, ...restorable } = state.restorable;
			return {
				restorable,
				drafts: {
					...state.drafts,
					[sessionId]: { ...vouched, ...state.drafts[sessionId] },
				},
			};
		});
	},

	set(sessionId: string, requestId: string, draft: QuestionDraft): void {
		useQuestionDraftStore.setState((state) => ({
			drafts: {
				...state.drafts,
				[sessionId]: { ...state.drafts[sessionId], [requestId]: draft },
			},
		}));
	},

	clear(sessionId: string, requestIds: string[]): void {
		useQuestionDraftStore.setState((state) => {
			const session = state.drafts[sessionId];
			if (!session) return state;
			const next = { ...session };
			for (const id of requestIds) delete next[id];
			return { drafts: { ...state.drafts, [sessionId]: next } };
		});
	},
};

/** The drafts of one session, or an empty map — stable, so it is safe to subscribe to. */
const NO_DRAFTS: Record<string, QuestionDraft> = {};

export function selectSessionDrafts(sessionId: string) {
	return (state: QuestionDraftState): Record<string, QuestionDraft> =>
		state.drafts[sessionId] ?? NO_DRAFTS;
}

/** Whether a draft holds anything the user would notice losing. */
export function isDraftDirty(draft: QuestionDraft | undefined): boolean {
	if (!draft) return false;
	return (
		draft.labels.length > 0 ||
		draft.text.trim() !== "" ||
		draft.declined ||
		draft.note.trim() !== ""
	);
}

/**
 * Whether a draft is a complete answer — what the footer's `{k} of {n}` counts.
 *
 * `hasOptions` is asked for rather than inferred, because it decides what the
 * text means: beside options it is the **Other** answer and only counts when
 * Other is picked, and with none it is the whole answer.
 */
export function isDraftReady(
	draft: QuestionDraft | undefined,
	hasOptions: boolean,
): boolean {
	if (!draft) return false;
	if (draft.declined) return true;
	const wrote = draft.text.trim() !== "";
	if (!hasOptions) return wrote;
	return draft.labels.length > 0 || (draft.otherPicked && wrote);
}
