/**
 * The border and focus treatment of a bordered text field, textarea or select.
 * Padding, type size, fill and radius vary by context and stay at the call site.
 *
 * One definition because a bare `focus:border-*` is easy to miss: in the light
 * themes a 1px border changing colour is all but invisible, and the ring is
 * what makes the focused field readable at a glance. `focus:` rather than
 * `focus-visible:` since a field needs its focus shown however it was reached —
 * the user has to see where they are typing. Buttons keep `focus-visible:`.
 */
export const inputClass =
	"border border-th-border focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20";

/**
 * `inputClass`'s focus treatment, for a bordered box whose field has none of
 * its own — a borderless textarea set inline beside a number and handles,
 * where a ring on the field itself would overlap its neighbours. The box shows
 * the focus instead. `focus-within:` also lights for the box's buttons, which
 * still names the right box. Kept beside `inputClass` so the two change
 * together; Tailwind only sees whole class literals, so they cannot share one.
 */
export const inputFocusWithinClass =
	"focus-within:border-th-border-focus focus-within:ring-2 focus-within:ring-th-accent/20";
