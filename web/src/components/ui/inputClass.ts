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
