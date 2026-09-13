import { readFileSync } from "node:fs";
import { repoPath } from "./sourceScan";

/** An interactive element and everything it says about its own size. */
export interface Control {
	file: string;
	line: number;
	/** `button`, `a`, or the tag carrying `role="button"`. Only for messages. */
	tag: string;
	classes: string;
	/**
	 * Whether the element renders nothing but icons, which decides how much of
	 * it can be checked: an icon-only control owes a box on both axes, while one
	 * with text is only held to the height it wrote down itself.
	 */
	iconOnly: boolean;
}

/**
 * The body of every *top-level* `const` and `function`, keyed by name.
 *
 * Most buttons name their size rather than spelling it: `iconButtonClass(busy)`
 * and `getActionIconButtonClass(enabled)` both stand between the call site and
 * the pixels, the second one via another constant again. Bodies are collected
 * across every file and resolved by name on demand, so a `className={helper()}`
 * is read as what the helper says.
 *
 * Column 0 only, and only up to the next declaration in column 0. An earlier
 * cut of this matched at any indentation, so a local `const label = ...` inside
 * a component captured the rest of that component — and every button whose
 * label was called `label` was then measured against a stray `size-3` from an
 * unrelated icon.
 *
 * Names are global, so two files defining the same one merge, and only names a
 * `className` expression actually mentions are ever looked up. A class helper
 * sharing its name with something else would splice both, which is why bodies
 * have to look like classes before they count (see `looksLikeClasses`).
 */
export function classHelpers(files: string[]): Map<string, string> {
	const out = new Map<string, string>();
	const re = /^(?:export\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)\b/gm;
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		const declarations = [...source.matchAll(re)];
		declarations.forEach((m, i) => {
			const body = source.slice(
				m.index,
				declarations[i + 1]?.index ?? source.length,
			);
			out.set(m[1], `${out.get(m[1]) ?? ""} ${body}`);
		});
	}
	return out;
}

/**
 * Whether a helper is about classes, directly or through another helper.
 *
 * Splicing is by name, and a body mentions plenty of names that are not
 * helpers (`busy`, `enabled`, `string`). Without this, any top-level binding
 * sharing one of those names would be spliced in and a 44px class hiding in it
 * would quietly excuse a button that has no size of its own. The transitive
 * arm is what lets `getActionIconButtonClass` through: its own body is nothing
 * but a ternary between two constants.
 */
function looksLikeClasses(
	name: string,
	helpers: Map<string, string>,
	seen = new Set<string>(),
): boolean {
	if (seen.has(name)) return false;
	seen.add(name);
	const body = helpers.get(name);
	if (body === undefined) return false;
	if (
		/["`][^"`]*\b(?:flex|grid|items-|justify-|min-[hw]-|size-\d|[hw]-\d|rounded|gap-)/.test(
			body,
		)
	) {
		return true;
	}
	return (body.match(/[A-Za-z_$][\w$]*/g) ?? []).some((n) =>
		looksLikeClasses(n, helpers, seen),
	);
}

/** An expression with every class helper it names spliced in, transitively. */
function expand(
	expression: string,
	helpers: Map<string, string>,
	seen = new Set<string>(),
): string {
	let out = expression;
	for (const name of expression.match(/[A-Za-z_$][\w$]*/g) ?? []) {
		if (seen.has(name)) continue;
		const body = helpers.get(name);
		if (body === undefined || !looksLikeClasses(name, helpers)) continue;
		seen.add(name);
		out += ` ${expand(body, helpers, seen)}`;
	}
	return out;
}

/** The end index of a JSX open tag starting at `start`, brace-aware. */
function openTagEnd(source: string, start: number): number {
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		else if (ch === ">" && depth === 0) return i;
	}
	return -1;
}

/**
 * True when the button renders nothing but icons.
 *
 * A control with a visible label is sized by its text and padding, which no
 * amount of string matching turns into pixels; an icon-only one has to state
 * its own box, so it is the only kind this check can speak about.
 *
 * Elements go first, then what is left of each interpolation decides: the
 * condition of a ternary is not rendered, so `{busy ? <Spinner /> : <Save />}`
 * leaves nothing behind and is an icon, while `{label}` and
 * `{busy ? <Spinner /> : "Save"}` both leave a rendered branch and are not.
 *
 * A label rendered by a child component (`<BranchName />`) reads as an icon
 * here, so such a button is asked to state a box it does not strictly owe. That
 * is the safe direction to be wrong in — it demands a number where the rule
 * would have accepted a measurement — and it is how the 36px branch row was
 * found.
 */
function isIconOnly(children: string): boolean {
	let rest = children.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
	rest = rest.replace(/<[^<>]*>/g, " ");
	let previous: string;
	do {
		previous = rest;
		rest = rest.replace(/\{([^{}]*)\}/g, (_, inner: string) =>
			rendersText(inner) ? "TEXT" : " ",
		);
	} while (rest !== previous);
	return !/\S/.test(rest);
}

/** Whether an interpolation renders anything once its elements are gone. */
function rendersText(expression: string): boolean {
	const branches = expression.split(/\?|:|&&|\|\|/);
	// The first part of a conditional is the test, which is never rendered.
	if (/\?|&&|\|\|/.test(expression)) branches.shift();
	return branches.some((branch) => /[^\s(),;]/.test(branch));
}

/**
 * Controls the file only ever renders to a mouse, by the name of the boolean
 * that gates them.
 *
 * A P2 shortcut may be left out entirely on a coarse pointer (the step list's
 * drag handle is, since HTML5 drag never fires for a finger), and something
 * that is not rendered cannot miss a hit-area floor. Recognised by the binding
 * rather than by a marker class, so the gate that decides it is the same one
 * the check reads — a marker could go stale the day the gate changed.
 */
function finePointerGuards(source: string): string[] {
	return [...source.matchAll(/\b(\w+)\s*=\s*useHasFinePointer\(\)/g)].map(
		(m) => m[1],
	);
}

/**
 * Every element a finger can activate, whatever tag it was written as.
 *
 * A `<button>` is the common case but never was the rule: `web-cluster`'s node
 * card opens its two URLs with `<a>`, and a whole list row is routinely a
 * `<div onClick>`. Scanning only `<button>` meant the floor stopped applying at
 * the moment an author reached for a different tag, which is not a distinction
 * a thumb can make.
 *
 * `role="button"` rather than `onClick`: a click handler on a wrapper is
 * frequently delegation for a real control nested inside it, and that control
 * states its own box. The role is the author saying this element is itself the
 * target.
 */
export function interactiveControls(
	file: string,
	helpers: Map<string, string>,
): Control[] {
	const source = readFileSync(file, "utf8");
	const guards = finePointerGuards(source);
	const out: Control[] = [];
	for (const m of source.matchAll(/<([a-z][\w-]*)\b/g)) {
		const name = m[1];
		const end = openTagEnd(source, m.index + m[0].length);
		if (end < 0) continue;
		const tag = source.slice(m.index, end);
		const interactive =
			name === "button" || name === "a" || /\brole="button"/.test(tag);
		if (!interactive) continue;

		let children = "";
		if (source[end - 1] !== "/") {
			const close = elementEnd(source, end, name);
			if (close < 0) continue;
			children = source.slice(end + 1, close);
		}

		const preamble = source.slice(Math.max(0, m.index - 200), m.index);
		if (guards.some((g) => new RegExp(`\\{\\s*${g}\\s*&&`).test(preamble)))
			continue;

		const cm = tag.match(/className=(?:"([^"]*)"|\{([\s\S]*)\})/);
		const classes =
			cm?.[2] === undefined
				? (cm?.[1] ?? "")
				: expand(cm[2], helpers).replace(/[`"'${}]/g, " ");
		out.push({
			file: repoPath(file),
			line: source.slice(0, m.index).split("\n").length,
			tag: name,
			classes: classes.replace(/\s+/g, " ").trim(),
			iconOnly: isIconOnly(children),
		});
	}
	return out;
}

const SPACING_UNIT = 4; // px per Tailwind spacing step
/** Exported so responsiveTokens.test.ts can pin the `touch-target` utility to
 * the same two numbers this scanner reads it as satisfying. */
export const FINE_FLOOR = 36;
export const COARSE_FLOOR = 44;

/**
 * Tags whose default `display` is `inline`, where CSS drops `height` and
 * `min-height` on the floor.
 *
 * The scan reads a class list and concludes a number of pixels, and for these
 * tags that conclusion can be false: `<a class="min-h-11">` is 44px only if
 * something else blockified it. A flex or grid *parent* does, which is why the
 * node card's two links happen to work — but that is the parent's doing and can
 * be undone from another file, so the element is asked to say it itself.
 */
const INLINE_BY_DEFAULT = new Set([
	"a",
	"span",
	"label",
	"em",
	"strong",
	"b",
	"i",
	"code",
	"small",
]);

/**
 * Tokens that blockify, so a size on one of these tags means something again.
 *
 * Bare `inline` deliberately does not match. `absolute` / `fixed` do: an
 * out-of-flow box is blockified whatever `display` says, which is what makes
 * the drawer backdrop's `fixed inset-0` a real size.
 */
const BLOCKIFIES =
	/^(?:[\w-]+:)*(?:(?:inline-)?(?:flex|grid|block|table)|absolute|fixed)$/;

/** Variants that make a token say something about width, not about the pointer. */
const WIDTH_PREFIXED = /(?:^|:)(?:max-)?(?:sm|md|lg|xl|2xl):/;

/**
 * The px a sizing token asks for, or null if it is not one.
 *
 * A size behind a width prefix does not count. `sm:size-11` promises 44px to a
 * wide viewport, which is exactly the mini pad mistake this rule exists to
 * undo — a phone-width touch screen would still be handed the small box, and a
 * narrow desktop window would be handed the large one.
 */
function sizePx(token: string): { axes: string; px: number } | null {
	if (WIDTH_PREFIXED.test(token)) return null;
	const m = token.match(
		/^(?:[\w-]+:)*(size|h|w|min-h|min-w)-(?:\[(\d+)px\]|(\d+(?:\.\d+)?))$/,
	);
	if (!m) return null;
	const px = m[2] ? Number(m[2]) : Number(m[3]) * SPACING_UNIT;
	const axes = m[1] === "size" ? "hw" : m[1].endsWith("h") ? "h" : "w";
	return { axes, px };
}

/**
 * Tokens that hand an axis to the layout, so no fixed size is expected on it.
 *
 * Listed per axis rather than per token: `flex-1` in a row says nothing about
 * height, and a 36px row that fills the width is still 36px under a thumb —
 * granting both was hiding exactly that in the branch bar. `inset-0` really
 * does hand over both, and every token that matches is applied, so it appears
 * on both lines rather than silently claiming only the first.
 *
 * The limit, stated plainly: the axis is credited with the full floor and the
 * parent it was handed to is read by nothing, because a container is not an
 * interactive element. A `self-stretch` button in a 32px row passes here. Both
 * of today's uses hold — `GroupHeader`'s row is
 * `min-h-[32px] pointer-coarse:min-h-11`, `FileTreeNode`'s is `min-h-[44px]` —
 * but a person checked that, not this file (docs/responsive-ui.md, blind spot
 * 5).
 */
const STRETCHED: [axis: "h" | "w", pattern: RegExp][] = [
	["w", /^(?:[\w-]+:)*(?:w-full|flex-1|flex-auto|grow|inset-0|inset-x-0)$/],
	["h", /^(?:[\w-]+:)*(?:h-full|self-stretch|inset-0|inset-y-0)$/],
];

/**
 * Why this control misses the floors in docs/responsive-ui.md, if it does.
 *
 * A control may reach the coarse floor either by growing its box behind
 * `pointer-coarse:` or by laying `touch-target` over it — the rule is a hit
 * area, not a box, and which one is right depends on whether the container can
 * absorb the extra pixels.
 *
 * How much can be said depends on whether the control has text. An icon-only
 * one owes a box on both axes, and declaring no size at all is a failure in its
 * own right: an icon inside a `p-1` is 28px however sympathetically you read
 * it, and leaving it implicit is how the sheet close button stayed that size.
 * One with text is sized by that text and its padding, which no amount of
 * string matching turns into pixels — but the moment it writes a height down
 * itself, that number is readable and is held to the same floors. That is the
 * whole of the gap this covers, and it is where the send button sat: `h-9`,
 * spelled out, with nothing to grow it under a thumb.
 *
 * What still nobody guards, stated plainly rather than hopefully: a control
 * with text and no height of its own. `py-1.5` around one line of `text-xs`
 * (12px on a 16px line box) is 28px, and this returns null for it. Only a
 * person reading the rendered page catches that one — and 66 controls are in
 * that shape today, the shortest of them 16px (docs/responsive-ui.md, "Outside
 * the floor today"). The floor is scoped to what is readable here; those are
 * known and deferred, not exempt.
 */
export function hitAreaFault(control: Control): string | null {
	const tokens = control.classes.split(/\s+/).filter(Boolean);
	if (tokens.includes("touch-target")) return null;

	const best = { h: { fine: 0, coarse: 0 }, w: { fine: 0, coarse: 0 } };
	const declared = { h: false, w: false };
	let sized = false;
	for (const token of tokens) {
		let stretched = false;
		for (const [axis, pattern] of STRETCHED) {
			if (!pattern.test(token)) continue;
			stretched = true;
			sized = true;
			best[axis] = { fine: COARSE_FLOOR, coarse: COARSE_FLOOR };
		}
		if (stretched) continue;
		const size = sizePx(token);
		if (!size) continue;
		sized = true;
		const coarseOnly = /(?:^|:)pointer-coarse:/.test(token);
		for (const axis of size.axes) {
			const slot = best[axis as "h" | "w"];
			declared[axis as "h" | "w"] = true;
			slot.coarse = Math.max(slot.coarse, size.px);
			if (!coarseOnly) slot.fine = Math.max(slot.fine, size.px);
		}
	}

	// On `sized`, not just on an explicit height: `w-full` and `h-full` are
	// dropped on an inline box for the same reason a `min-h` is. Checked after
	// the loop rather than up front so a control that stated no size at all is
	// not asked for a display it has no use for — it gets the plainer message
	// below — and after the `touch-target` return, because that overlay is an
	// absolutely positioned pseudo-element and does reach its floors from an
	// inline parent.
	if (
		sized &&
		INLINE_BY_DEFAULT.has(control.tag) &&
		!tokens.some((t) => BLOCKIFIES.test(t))
	) {
		return `<${control.tag}> is inline by default, so the size it states is dropped; blockify it`;
	}

	if (!control.iconOnly) {
		// Its width is the text's business, and a height it never wrote down is
		// not this check's to invent.
		if (!declared.h) return null;
		return axisFault("h", best.h);
	}
	if (!sized) return "declares no box size at all";
	const faults = (["h", "w"] as const)
		.map((axis) => axisFault(axis, best[axis]))
		.filter((f): f is string => f !== null);
	return faults.length ? faults.join("; ") : null;
}

function axisFault(
	axis: "h" | "w",
	px: { fine: number; coarse: number },
): string | null {
	const name = axis === "h" ? "height" : "width";
	if (px.coarse < COARSE_FLOOR) {
		return `${name} is ${px.coarse}px on a coarse pointer, below the ${COARSE_FLOOR}px floor`;
	}
	if (px.fine < FINE_FLOOR) {
		return `${name} is ${px.fine}px on a fine pointer, below the ${FINE_FLOOR}px floor`;
	}
	return null;
}

/** A flex/grid container that puts controls next to each other. */
export interface Cluster {
	file: string;
	line: number;
	classes: string;
	controls: number;
}

const MIN_COARSE_GAP = 8;

/** The end index of the element opened at `start`, or -1. */
function elementEnd(source: string, start: number, tag: string): number {
	let depth = 1;
	const re = new RegExp(`<(/?)${tag}\\b`, "g");
	for (const m of source.slice(start).matchAll(re)) {
		depth += m[1] ? -1 : 1;
		if (depth === 0) return start + m.index;
	}
	return -1;
}

/** Matches the opening tag of anything `interactiveControls` would collect. */
const INTERACTIVE_TAG = /<(?:button|a)\b|<[a-z][\w-]*\b[^>]*\brole="button"/g;

/**
 * Every container that lays two or more controls side by side, with the gap it
 * asks for.
 *
 * The same set of tags the hit-area check reads, for the same reason: the two
 * halves are one rule — a 44px target is only 44px of target if the next one
 * does not start inside it — and a rule that stopped at `<button>` on this side
 * would leave two `<a>` chips free to sit 4px apart with both of them passing.
 *
 * Self-closing elements are skipped by construction: a container with children
 * always has a closing tag to find.
 *
 * Two things stay out of reach, and both have to be read by a person. A
 * container that states no `gap-` at all is not collected here, so two boxes
 * touching edge to edge are never measured — the scan reads the gap a row asks
 * for, and a row that asks for nothing leaves nothing to read. And only
 * controls written literally inside the container are seen: a row that takes
 * its actions as a prop — SidebarListItem does — puts none of these tags in its
 * own source. Both verified by mutation: dropping a gapped row's `gap-`
 * entirely, and repacking SidebarListItem to `gap-1`, each leave this test
 * green.
 */
export function buttonClusters(file: string): Cluster[] {
	const source = readFileSync(file, "utf8");
	const out: Cluster[] = [];
	for (const m of source.matchAll(/<(div|span|ul|li|nav|form)\b/g)) {
		const open = openTagEnd(source, m.index + m[0].length);
		if (open < 0 || source[open - 1] === "/") continue;
		const tag = source.slice(m.index, open);
		const cm = tag.match(/className=(?:"([^"]*)"|\{([\s\S]*)\})/);
		const classes = (cm?.[1] ?? cm?.[2] ?? "").replace(/[`"'${}]/g, " ");
		if (!/(?:^|\s)(?:[\w-]+:)*gap-/.test(classes)) continue;
		const close = elementEnd(source, open, m[1]);
		if (close < 0) continue;
		const inner = source.slice(open, close);
		// Only this container's own row: a nested gapped container states its own.
		const own = inner.replace(
			/<(div|span|ul|li|nav|form)\b[^>]*gap-[\s\S]*?<\/\1>/g,
			" ",
		);
		const controls = (own.match(INTERACTIVE_TAG) ?? []).length;
		if (controls < 2) continue;
		out.push({
			file: repoPath(file),
			line: source.slice(0, m.index).split("\n").length,
			classes: classes.replace(/\s+/g, " ").trim(),
			controls,
		});
	}
	return out;
}

/**
 * Why a row of controls is packed too tightly for a thumb, if it is.
 *
 * 8px between neighbouring hit areas, because a 44px target is only 44px of
 * target if the next one does not start inside it. Only the gap is read, not
 * the boxes: the boxes are the other half of the rule and are checked above, so
 * anything that passes both is 44px apart with 8px of air.
 */
export function spacingFault(cluster: Cluster): string | null {
	let gap = 0;
	let coarseGap = 0;
	for (const token of cluster.classes.split(/\s+/)) {
		if (WIDTH_PREFIXED.test(token)) continue;
		const g = token.match(/^(?:[\w-]+:)*gap-(?:\[(\d+)px\]|(\d+(?:\.\d+)?))$/);
		if (!g) continue;
		const px = g[1] ? Number(g[1]) : Number(g[2]) * SPACING_UNIT;
		coarseGap = Math.max(coarseGap, px);
		if (!/(?:^|:)pointer-coarse:/.test(token)) gap = Math.max(gap, px);
	}
	if (coarseGap >= MIN_COARSE_GAP) return null;
	return `${cluster.controls} controls sit ${coarseGap || gap}px apart on a coarse pointer, below the ${MIN_COARSE_GAP}px floor`;
}
