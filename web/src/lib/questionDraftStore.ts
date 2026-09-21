import { create } from "zustand";

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
}

export const useQuestionDraftStore = create<QuestionDraftState>(() => ({
	drafts: {},
}));

/**
 * The drafts of one session's answer sheet, in memory only.
 *
 * A store rather than component state because every host of a draft unmounts
 * under the user: the sheet closes on a stray backdrop tap, the chat pane is
 * replaced whenever an overlay takes it, and the user switches sessions and
 * comes back. Component state loses the draft to all three, and the first of
 * them is a single mis-aimed thumb.
 *
 * It is **not** persisted. What a draft has to survive is a refused submit and
 * a dropped socket, neither of which reloads the page; writing it to
 * `localStorage` would resurrect an answer to a question withdrawn two days
 * ago, on a card that no longer exists.
 *
 * Two things clear one, and both are the user's own act: its submit succeeding,
 * and the user dismissing a block whose question something else has already
 * resolved. Nothing clears a draft behind their back — deleting text somebody
 * typed without showing it to them first is the failure this store exists to
 * prevent (docs/answering-ui.md §5).
 */
export const questionDraftActions = {
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
