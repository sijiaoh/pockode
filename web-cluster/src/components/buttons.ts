/**
 * The shapes every button in this panel is one of.
 *
 * Shared rather than repeated per file because the phase-2 card and the
 * phase-3 form sat side by side in the same sheet with hand-copied class
 * strings that had already drifted: the form's Cancel had lost the flex
 * centring its neighbour had, so its label sat a few pixels high against the
 * button right next to it. `min-h-[44px]` is the thumb target the whole app is
 * held to (see docs/responsive-ui.md), which is the other reason these belong
 * in one place.
 */
const BUTTON_BASE =
	"flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50";

export const PRIMARY_BUTTON = `${BUTTON_BASE} bg-th-accent text-th-accent-text hover:bg-th-accent-hover`;
export const NEUTRAL_BUTTON = `${BUTTON_BASE} border border-th-border text-th-text-primary hover:bg-th-overlay-hover`;
export const DANGER_BUTTON = `${BUTTON_BASE} bg-th-error text-th-text-inverse hover:opacity-90`;
export const MENU_ITEM =
	"flex min-h-[44px] items-center rounded-lg px-3 py-2 text-left hover:bg-th-overlay-hover";
