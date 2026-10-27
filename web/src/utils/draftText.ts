/**
 * The composer's draft with `text` added: in place of a draft that holds no
 * words, after the user's own a blank line apart otherwise, and not at all when
 * the draft already holds it — so a second press adds nothing. Never over the
 * user's words, and never asking: this is the one definition both *Restore to
 * input* and the prefill handoff use (docs/agent-handoff-ui.md §1.2).
 */
export function appendToDraft(draft: string, text: string): string {
	const added = text.trim();
	if (!added || draft.includes(added)) return draft;
	const kept = draft.trimEnd();
	return kept ? `${kept}\n\n${added}` : added;
}
