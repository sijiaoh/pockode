import type { TokenUsage } from "../types/message";

const UNITS = ["", "K", "M"];

// One decimal only below 100, where it still carries information: "1.5K" says
// something "2K" does not, while "128.4K" says nothing "128K" doesn't. Same
// rule formatBytes follows, on decimal steps: token counts are quoted in
// thousands by every provider, so a binary step would print a different number
// than the one the agent's own docs talk about.
function round(value: number, unit: number): number {
	return unit === 0 || value >= 100
		? Math.round(value)
		: Math.round(value * 10) / 10;
}

/** Every token the agent billed for, summed the way session.TokenUsage.Total() does. */
export function totalTokens(usage: TokenUsage): number {
	return (
		usage.input_tokens +
		usage.output_tokens +
		usage.cache_read_tokens +
		usage.cache_write_tokens
	);
}

/**
 * Abbreviated token count for surfaces with no room for the exact one, e.g.
 * `1536` -> `1.5K`.
 *
 * Only where width is scarce: the session info panel shows `formatExactTokens`
 * instead, because a figure a user opened a panel to read should be the real one.
 */
export function formatTokens(tokens: number): string {
	let value = Math.max(0, tokens);
	let unit = 0;
	while (value >= 1000 && unit < UNITS.length - 1) {
		value /= 1000;
		unit++;
	}

	let rounded = round(value, unit);
	// Rounding can land on the next unit on its own: 999,950 divides to 999.95K,
	// which stays in the loop's unit but prints as "1000K".
	if (rounded >= 1000 && unit < UNITS.length - 1) {
		value /= 1000;
		unit++;
		rounded = round(value, unit);
	}

	return `${rounded}${UNITS[unit]}`;
}

/**
 * The exact count, grouped: `1248301` -> `1,248,301`.
 *
 * Fixed to en-US rather than the visitor's locale, as every other string on
 * these surfaces is: a French browser would otherwise read "1 248 301" beside
 * English labels, and the grouped figure is also what the spoken label carries.
 */
export function formatExactTokens(tokens: number): string {
	return Math.max(0, tokens).toLocaleString("en-US");
}

/**
 * A price as the provider bills it: `3.4159` -> `$3.42`.
 *
 * Always two decimals, with one floor — anything under a cent that is not zero
 * prints `<$0.01`, so a real spend never renders as nothing. Exactly zero stays
 * `$0.00`; an agent that reports no price at all has no cost figure to format
 * (its `cost_usd` is absent, and the caller shows no row).
 */
export function formatCost(usd: number): string {
	if (usd > 0 && usd < 0.01) return "<$0.01";
	return `$${Math.max(0, usd).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

/**
 * How full a context window is: `formatContextPercent(92134, 200000)` -> `46%`.
 *
 * Whole percents, with a floor at the bottom only: a window with something in it
 * must not read as empty, while rounding up to `100%` just before it is full is
 * the correct warning to give. `window` is the size the agent reported, so it is
 * never zero — the caller has no percentage to show until it has one.
 */
export function formatContextPercent(used: number, window: number): string {
	const percent = Math.round((used / window) * 100);
	if (percent === 0 && used > 0) return "<1%";
	return `${percent}%`;
}
