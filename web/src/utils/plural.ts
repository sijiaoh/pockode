/** `1 step` / `2 steps`, written out rather than left as `step(s)`. */
export function countOf(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
