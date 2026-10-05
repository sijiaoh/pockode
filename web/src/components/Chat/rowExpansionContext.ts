import { createContext, useContext, useState } from "react";

interface RowExpansion {
	/** What the user last chose for this row's body; absent until they choose. */
	choice?: boolean;
	setChoice: (expanded: boolean) => void;
}

/**
 * A row's open body, held by the list it sits in rather than by the row. The
 * list has to know which rows the user opened: one the user is reading must not
 * be folded out of sight when its group forms or closes, and only the user's
 * own choice counts for that — a pending card opens itself, and folding it
 * once answered is the point. A context rather than props because the row is
 * drawn several renderers down from the list, through the part renderer a
 * subagent's Process shares.
 */
export const RowExpansionContext = createContext<RowExpansion | null>(null);

/**
 * The row's expanded state, starting at `initial` until the user toggles it.
 * Outside a list it is the row's own.
 */
export function useRowExpanded(
	initial = false,
): [boolean, (expanded: boolean) => void] {
	const list = useContext(RowExpansionContext);
	const [own, setOwn] = useState(initial);
	if (!list) return [own, setOwn];
	return [list.choice ?? own, list.setChoice];
}

/**
 * Whether the list a row sits in is framed. A list of nothing but a thinking
 * is not, and its row is drawn bare, on the text's left edge, rather than on
 * the columns a frame's rows share
 * (docs/turn-progress-ui.md#12-where-it-goes-and-groups). Outside a list a row
 * is drawn as in a frame.
 */
export const RowFrameContext = createContext(true);
