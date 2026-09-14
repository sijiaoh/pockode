/**
 * Whether a value on screen is the stored one, still on its way, or not coming
 * at all. The last two look alike to the control — neither can be shown, and
 * neither can be edited — and differ only in whether a pulse would still be
 * telling the truth about something being underway.
 */
export type ValueState = "known" | "pending" | "unavailable";

/**
 * The accessible name a control keeps, or a placeholder takes over, while the
 * value it is named for is missing. "Loading" is only said where something is
 * actually loading.
 *
 * `known` is not one of the answers it takes: there is no waiting to name then,
 * and a signature that accepted it would have to invent a label for a value the
 * control is already showing.
 */
export function waitingLabel(
	field: string,
	state: Exclude<ValueState, "known">,
): string {
	return `${field}: ${state === "pending" ? "loading" : "unavailable"}`;
}
