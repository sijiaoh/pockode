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

/**
 * The composer's draft with `text` put in at `at`, the caret's offset — what a
 * paste there would do, but as a block of its own: a blank line apart from the
 * user's words on either side, so a fence never starts mid-line. Nothing is
 * replaced — only the blank space at the cut gives way, and the next line
 * keeps its indent — and a draft that already holds the text is left as it
 * is, the rule `appendToDraft` keeps, with the caret where it was. A caret
 * inside a fenced block — one put in earlier, clicked into to reread it — is
 * taken past its closing fence, since a block in there would split it. `caret`
 * is where typing goes on: a fresh line under the block, for the instruction
 * it was put there to go with.
 */
export function insertIntoDraft(
	draft: string,
	text: string,
	at: number,
): { draft: string; caret: number } {
	const added = text.trim();
	if (!added || draft.includes(added)) return { draft, caret: at };
	at = pastFence(draft, at);
	const before = draft.slice(0, at).trimEnd();
	const after = wordsAfterCut(draft.slice(at));
	const head = before ? `${before}\n\n${added}\n` : `${added}\n`;
	return {
		draft: `${head}\n${after}`,
		caret: after ? head.length : head.length + 1,
	};
}

/** Past a line break, the next line's indent is the user's, not the cut's. */
function wordsAfterCut(rest: string): string {
	if (!rest.trim()) return "";
	const blank = rest.match(/^\s*\n/);
	return blank ? rest.slice(blank[0].length) : rest.trimStart();
}

/**
 * `at`, or the end of the fenced block it is inside: CommonMark's rule, a
 * fence closed by a run of the same character at least as long, or by the end
 * of the text.
 */
function pastFence(draft: string, at: number): number {
	let open: { start: number; run: string } | null = null;
	let start = 0;
	for (const line of draft.split("\n")) {
		const end = start + line.length;
		const run = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
		if (!open) {
			if (run) open = { start, run };
		} else if (
			run?.[0] === open.run[0] &&
			run.length >= open.run.length &&
			!line.trim().slice(run.length).trim()
		) {
			if (open.start < at && at < end) return end;
			open = null;
		}
		start = end + 1;
	}
	return open && open.start < at ? draft.length : at;
}
