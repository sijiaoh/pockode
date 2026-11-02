/**
 * The width a block may take that is wider than the reading column: the
 * transcript's scroller inside its gutters, which `MessageList` keeps on the
 * scroller. Unset outside a transcript, where nothing is wider than its column.
 */
export const TRANSCRIPT_SPAN_VAR = "--transcript-span";

/** The widest a wide block is drawn: past it, a desktop is mostly margin. */
const WIDE_MAX = "80rem";

const WIDE_WIDTH = `max(100%, min(${WIDE_MAX}, var(${TRANSCRIPT_SPAN_VAR}, 0px)))`;

/**
 * The style that takes a block out of the reading column to the transcript's
 * width, up to `WIDE_MAX`, centered on the transcript. For a block whose
 * parent is the reading column itself, edge to edge: the column is centered on
 * the transcript, so centering on the column is centering on it. Never
 * narrower than the column, which is the whole of it outside a transcript and
 * on a phone.
 */
export const WIDE_BLOCK_STYLE = {
	width: WIDE_WIDTH,
	marginLeft: `calc((100% - ${WIDE_WIDTH}) / 2)`,
} as const;
