import { readFileSync } from "node:fs";
import { repoPath } from "./sourceScan";

/** An interactive element and everything it says about its own size. */
export interface Control {
	file: string;
	line: number;
	/** `button`, `a`, or the tag carrying `role="button"`. Only for messages. */
	tag: string;
	/**
	 * Every class list this element can end up with: one entry per combination
	 * of branches its `className` expression and the helpers it names can take.
	 * A call site has to clear the floors on all of them, because which one it
	 * gets is decided by arguments this scan does not evaluate.
	 */
	classes: string[];
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

/** Longest body whose names `looksLikeClasses` follows. See below. */
const TRANSITIVE_BODY_LIMIT = 500;

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
	// Only a short body is followed. The arm exists for a declaration that is
	// nothing but a reference to another one, and those are one line; a body long
	// enough to be a function with logic reaches a class string by accident, and
	// following that accident splices whole modules in — `items-start` yields the
	// name `start`, which led through eleven more declarations to the WebSocket
	// store. Everything it dragged along was credited to the control.
	if (body.length > TRANSITIVE_BODY_LIMIT) return false;
	return (body.match(/[A-Za-z_$][\w$]*/g) ?? []).some((n) =>
		looksLikeClasses(n, helpers, seen),
	);
}

/**
 * The most branch combinations one `className` expression is enumerated into.
 *
 * Class helpers have a handful of ternaries between them, so the real counts
 * are 2 and 4. The cap exists for the pathological splice: `classHelpers` runs
 * a body to the next top-level declaration, so a mis-named helper can drag a
 * whole component in. Past the cap a branch point collapses back to the union
 * of its branches — the old, over-permissive reading — rather than dropping
 * combinations, which would drop faults silently.
 */
const MAX_VARIANTS = 64;

/** Every `a` continued by every `b`, collapsing `b` if the product overflows. */
function cross(a: string[], b: string[]): string[] {
	if (b.length === 0) return a;
	const bs = a.length * b.length > MAX_VARIANTS ? [b.join(" ")] : b;
	return a.flatMap((x) => bs.map((y) => `${x} ${y}`));
}

/**
 * The index just past a line or block comment starting at `i`, or -1.
 *
 * Comments are skipped rather than scanned. An apostrophe in one is not a
 * string, and letting the string scanner see it swallows everything up to the
 * next quote: a single `can't` in `iconButtonClass` ate the class list, and the
 * scan stayed green through a mutation that had just deleted both coarse
 * floors. A guard that a comment can switch off is worse than no guard.
 *
 * Only a comment opener matches, so a lone `/` — division — does not. A regex
 * literal is read as code, which is harmless: classes do not live in one.
 */
function commentEnd(text: string, i: number): number {
	if (text[i] !== "/") return -1;
	if (text[i + 1] === "/") {
		const nl = text.indexOf("\n", i);
		return nl < 0 ? text.length : nl;
	}
	if (text[i + 1] !== "*") return -1;
	const end = text.indexOf("*/", i + 2);
	return end < 0 ? text.length : end + 2;
}

/** The index just past the string, template or bracket group starting at `i`. */
function atomEnd(text: string, i: number): number {
	const open = text[i];
	if (open === '"' || open === "'") {
		for (let j = i + 1; j < text.length; j++) {
			if (text[j] === "\\") j++;
			else if (text[j] === open) return j + 1;
		}
		return text.length;
	}
	if (open === "`") {
		for (let j = i + 1; j < text.length; j++) {
			if (text[j] === "\\") j++;
			else if (text[j] === "`") return j + 1;
			// A substitution may hold a backtick of its own, so skip the braces.
			else if (text[j] === "$" && text[j + 1] === "{")
				j = atomEnd(text, j + 1) - 1;
		}
		return text.length;
	}
	// Only the matching bracket is counted: valid source never interleaves two
	// kinds, so a nested `[` cannot close a `(`.
	const close = open === "(" ? ")" : open === "[" ? "]" : "}";
	let depth = 0;
	for (let j = i; j < text.length; j++) {
		const ch = text[j];
		if (ch === '"' || ch === "'" || ch === "`") {
			j = atomEnd(text, j) - 1;
			continue;
		}
		const comment = commentEnd(text, j);
		if (comment >= 0) {
			j = comment - 1;
			continue;
		}
		if (ch === open) depth++;
		else if (ch === close && --depth === 0) return j + 1;
	}
	return text.length;
}

/** The outermost `? :` pair in `text`, or null if it holds none. */
function topLevelTernary(
	text: string,
): { question: number; colon: number } | null {
	let question = -1;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (
			ch === '"' ||
			ch === "'" ||
			ch === "`" ||
			ch === "(" ||
			ch === "[" ||
			ch === "{"
		) {
			i = atomEnd(text, i) - 1;
			continue;
		}
		const comment = commentEnd(text, i);
		if (comment >= 0) {
			i = comment - 1;
			continue;
		}
		if (ch === "?") {
			// `??`, `?.` and an optional marker are not conditionals.
			if (text[i + 1] === "?" || text[i + 1] === "." || text[i + 1] === ":") {
				i++;
				continue;
			}
			if (question < 0) question = i;
			depth++;
			continue;
		}
		if (ch === ":" && question >= 0 && --depth === 0)
			return { question, colon: i };
	}
	return null;
}

/**
 * Every class list an expression can produce, one string per combination of
 * branches taken.
 *
 * The reason this is a list and not a string: splicing a helper's body in as
 * one flat blob credits every call site with the classes of *all* its branches
 * at once. `iconButtonClass` is the shape that exposes it — one branch overlays
 * `touch-target`, the other grows the box — so every caller was waved through
 * on a class only half of them receive. A branch a call site may take has to be
 * readable on its own, and that is what a variant is.
 *
 * The condition is kept in both variants rather than cut out: telling a
 * ternary's condition from whatever legitimately precedes it (`clsx("flex",
 * cond ? ... )`) needs a real parser, and dropping the lot would lose the
 * `flex`. The cost is that a class-shaped string *inside* a condition is
 * credited to both branches — `variant === "size-11" ? …` would be read as
 * 44px. Nothing writes that, and it is the same order of limit as the rest of
 * this file.
 *
 * Nested ternaries are handled by counting: the matching `:` is the one that
 * brings the `?` depth back to zero, so `a ? x : b ? y : z` yields three.
 */
function alternatives(text: string): string[] {
	const t = topLevelTernary(text);
	if (!t) return inlineAlternatives(text);
	return cross(alternatives(text.slice(0, t.question)), [
		...alternatives(text.slice(t.question + 1, t.colon)),
		...alternatives(text.slice(t.colon + 1)),
	]);
}

/** `alternatives` for text whose branch points are all inside brackets. */
function inlineAlternatives(text: string): string[] {
	let out = [""];
	let plain = "";
	const flush = () => {
		if (!plain) return;
		const held = plain;
		out = out.map((v) => `${v} ${held}`);
		plain = "";
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (
			ch === '"' ||
			ch === "'" ||
			ch === "`" ||
			ch === "(" ||
			ch === "[" ||
			ch === "{"
		) {
			const end = atomEnd(text, i);
			const inner = text.slice(i + 1, end - 1);
			i = end - 1;
			// A quoted string is a leaf; a bracket group is code and may hold a
			// ternary; a template is neither and gets its own walk.
			if (ch === '"' || ch === "'") plain += ` ${inner} `;
			else {
				flush();
				out = cross(
					out,
					ch === "`" ? templateAlternatives(inner) : alternatives(inner),
				);
			}
			continue;
		}
		const comment = commentEnd(text, i);
		if (comment >= 0) {
			i = comment - 1;
			continue;
		}
		plain += ch;
	}
	flush();
	return out;
}

/**
 * `alternatives` for the inside of a template literal, where the only branch
 * point is a `${}`.
 *
 * A template's literal text is classes, not code, and a class may contain
 * brackets: reading `min-h-[44px]` as an array subscript cut it into `min-h-`
 * and `44px`, and every `min-h-[44px]` row was suddenly a height of nothing.
 */
function templateAlternatives(text: string): string[] {
	let out = [""];
	let plain = "";
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "$" && text[i + 1] === "{") {
			const end = atomEnd(text, i + 1);
			if (plain) {
				const held = plain;
				out = out.map((v) => `${v} ${held}`);
				plain = "";
			}
			out = cross(out, alternatives(text.slice(i + 2, end - 1)));
			i = end - 1;
			continue;
		}
		plain += text[i];
	}
	return plain ? out.map((v) => `${v} ${plain}`) : out;
}

/**
 * Every class list one helper's body can produce, computed once per helper.
 *
 * The memo is not an optimisation detail, it is what makes the enumeration
 * finish: a variant list is spliced into every *other* variant, so expanding a
 * helper afresh under each branch of its caller costs a product of the whole
 * tree. Keyed on the helper map so a fresh scan gets a fresh memo.
 *
 * The entry is keyed on the name alone while the reading also depends on the
 * `stack` it was first expanded under, so a helper first reached from inside a
 * cycle would hand its truncated reading to everyone. That reading holds fewer
 * classes, which credits a control with less and fails loudly; nothing here is
 * cyclic today.
 */
const memos = new WeakMap<Map<string, string>, Map<string, string[]>>();

/**
 * An expression with every class helper it names spliced in, transitively, once
 * per combination of branches.
 *
 * Names are collected per variant rather than from the whole expression, so a
 * helper that is a ternary between two constants (`getActionIconButtonClass`)
 * resolves to one constant per variant instead of both at once.
 *
 * `stack` breaks recursion between helpers. A cyclic pair is read as whatever
 * was resolvable from the outside, which is what the old single `seen` set did
 * too; nothing here is cyclic today.
 */
function expandVariants(
	expression: string,
	helpers: Map<string, string>,
	stack = new Set<string>(),
): string[] {
	const out = new Set<string>();
	for (const variant of alternatives(expression).map(condense)) {
		let texts = [variant];
		for (const name of new Set(variant.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
			if (stack.has(name)) continue;
			const body = helpers.get(name);
			if (body === undefined || !looksLikeClasses(name, helpers)) continue;
			texts = cross(texts, helperVariants(name, body, helpers, stack));
		}
		for (const text of texts) out.add(condense(text));
	}
	return capped([...out]);
}

/** At most `MAX_VARIANTS` entries, the overflow folded into one union of itself. */
function capped(variants: string[]): string[] {
	if (variants.length <= MAX_VARIANTS) return variants;
	return [
		...variants.slice(0, MAX_VARIANTS - 1),
		condense(variants.slice(MAX_VARIANTS - 1).join(" ")),
	];
}

/** `expandVariants` of a named helper's body, memoised. */
function helperVariants(
	name: string,
	body: string,
	helpers: Map<string, string>,
	stack: Set<string>,
): string[] {
	let memo = memos.get(helpers);
	if (!memo) {
		memo = new Map();
		memos.set(helpers, memo);
	}
	const hit = memo.get(name);
	if (hit) return hit;
	stack.add(name);
	const result = expandVariants(body, helpers, stack);
	stack.delete(name);
	memo.set(name, result);
	return result;
}

/**
 * A variant reduced to its distinct tokens.
 *
 * Splicing carries whole declaration bodies around, and a body repeats the same
 * few hundred tokens thousands of times over. Every reader downstream — class
 * matching and helper lookup alike — treats a variant as a set of tokens, so
 * dropping the repeats changes no answer. Without it, enumerating branches
 * multiplies whole component sources against each other and the scan runs the
 * heap out.
 */
function condense(text: string): string {
	const tokens = text.split(/[^\w$@:[\]./-]+/).filter((t) => /\w/.test(t));
	return [...new Set(tokens)].join(" ");
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
			cm?.[2] === undefined ? [cm?.[1] ?? ""] : expandVariants(cm[2], helpers);
		out.push({
			file: repoPath(file),
			line: source.slice(0, m.index).split("\n").length,
			tag: name,
			classes: [...new Set(classes.map((c) => c.replace(/\s+/g, " ").trim()))],
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
 * person reading the rendered page catches that one. It is not unknown, though:
 * `impliedHeight` computes exactly that arithmetic and `deferredControls`
 * collects every control in the shape, which is what keeps the register in
 * docs/responsive-ui.md derived rather than counted. The floor is scoped to
 * what can be demanded of an author; those are known and deferred, not exempt.
 *
 * Every branch the control's classes can take has to clear the floors, not just
 * one: the scan does not evaluate a helper's arguments, so any branch is a
 * branch some call site takes. Reading them as one merged blob is what let
 * `iconButtonClass`'s growing branch ride on the other branch's `touch-target`.
 */
export function hitAreaFault(control: Control): string | null {
	for (const classes of control.classes) {
		const fault = branchFault(control, classes);
		if (fault) {
			// Which branch, when there is more than one: the caller prints the class
			// lists anyway, and "36px" says nothing about which of them it came from.
			return control.classes.length > 1
				? `${fault} — on \`${classes}\``
				: fault;
		}
	}
	return null;
}

/** What one class list says about the box it makes. */
interface Measured {
	tokens: string[];
	/** The px each axis reaches, per pointer. */
	best: Record<"h" | "w", { fine: number; coarse: number }>;
	/** Whether a size token named the axis, as opposed to nothing at all. */
	declared: Record<"h" | "w", boolean>;
	/** Whether the axis was handed to the layout instead of being sized here. */
	stretched: Record<"h" | "w", boolean>;
	/** Whether anything at all — a size or a stretch — spoke about the box. */
	sized: boolean;
}

/** Every box number one class list states. Shared by the fault and the census. */
function measure(classes: string): Measured {
	const tokens = classes.split(/\s+/).filter(Boolean);
	const best = { h: { fine: 0, coarse: 0 }, w: { fine: 0, coarse: 0 } };
	const declared = { h: false, w: false };
	const stretched = { h: false, w: false };
	let sized = false;
	for (const token of tokens) {
		let handedOver = false;
		for (const [axis, pattern] of STRETCHED) {
			if (!pattern.test(token)) continue;
			handedOver = true;
			sized = true;
			stretched[axis] = true;
			best[axis] = { fine: COARSE_FLOOR, coarse: COARSE_FLOOR };
		}
		if (handedOver) continue;
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
	return { tokens, best, declared, stretched, sized };
}

/** `hitAreaFault` for one of the class lists the control may end up with. */
function branchFault(control: Control, classes: string): string | null {
	const { tokens, best, declared, sized } = measure(classes);
	if (tokens.includes("touch-target")) return null;

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

/**
 * Tailwind 4's default type scale: the font size each `text-` step sets and the
 * line box that comes with it.
 *
 * Written down rather than read out of the stylesheet because a default is not
 * in the stylesheet — it only appears there once someone overrides it in
 * `@theme`. responsiveTokens.test.ts holds both stylesheets to having *not*
 * overridden them, so this table stays the truth rather than merely starting
 * out as it.
 */
const TYPE_SCALE: Record<string, { font: number; line: number }> = {
	xs: { font: 12, line: 16 },
	sm: { font: 14, line: 20 },
	base: { font: 16, line: 24 },
	lg: { font: 18, line: 28 },
	xl: { font: 20, line: 28 },
	"2xl": { font: 24, line: 32 },
	"3xl": { font: 30, line: 36 },
	"4xl": { font: 36, line: 40 },
	"5xl": { font: 48, line: 48 },
};

/** `leading-` steps that are a multiple of the font size rather than px. */
const LEADING_FACTORS: Record<string, number> = {
	none: 1,
	tight: 1.25,
	snug: 1.375,
	normal: 1.5,
	relaxed: 1.625,
	loose: 2,
};

/**
 * The line box of a control that states no font size of its own.
 *
 * Neither app sets a root font size, so the browser default of 16px stands, and
 * preflight sets `line-height: 1.5` on `html` — a unitless value, so it
 * inherits as a factor and every descendant that does not restate it lands
 * here. It is what to use when the font size comes from an ancestor in another
 * file — and it is a ceiling, not a measurement: almost every ancestor that
 * sets one sets `text-sm` or `text-xs`, which makes the real box *shorter*.
 * That is the unsafe direction for a floor, which is why a height resting on it
 * is reported as an upper bound and never mixed in with a height that was read.
 */
const INHERITED_LINE_BOX = 24;

/** The height one class list implies, and how much of it was read vs assumed. */
export interface ImpliedHeight {
	/** Line box plus vertical padding, per pointer. */
	fine: number;
	coarse: number;
	/** True when the font size came from an ancestor, so the line box is the
	 * browser default rather than a number this control wrote down. */
	inherited: boolean;
}

/** px of vertical padding a token adds, or null if it is not padding. */
function paddingPx(token: string): { edges: number; px: number } | null {
	if (WIDTH_PREFIXED.test(token)) return null;
	const m = token.match(
		/^(?:[\w-]+:)*(p|py|pt|pb)-(?:\[(\d+(?:\.\d+)?)px\]|(\d+(?:\.\d+)?))$/,
	);
	if (!m) return null;
	const px = m[2] ? Number(m[2]) : Number(m[3]) * SPACING_UNIT;
	return { edges: m[1] === "pt" || m[1] === "pb" ? 1 : 2, px };
}

/**
 * The line box one class list asks for, or null if it names a step this table
 * cannot read.
 *
 * Null is not "no font size" — that is `INHERITED_LINE_BOX`. It means a token
 * was recognised as type but not understood, and the census asserts there are
 * none, so a new `leading-` shape shows up as a red test rather than as a
 * height quietly computed from the wrong number.
 */
function lineBox(tokens: string[]): { px: number; inherited: boolean } | null {
	let font: number | undefined;
	let line: number | undefined;
	let leadingFactor: number | undefined;
	for (const token of tokens) {
		if (WIDTH_PREFIXED.test(token)) continue;
		const bare = token.replace(/^(?:[\w-]+:)*/, "");
		const text = bare.match(/^text-(\[.+\]|[a-z0-9]+)$/);
		if (text) {
			const step = TYPE_SCALE[text[1]];
			if (step) {
				font = step.font;
				line = step.line;
				continue;
			}
			if (text[1].startsWith("[")) {
				const px = text[1].match(/^\[(\d+(?:\.\d+)?)px\]$/);
				// Any other arbitrary value — a rem, a `length:inherit` — is a font
				// size this cannot turn into pixels, and reading it as "no font size
				// stated" would quietly hand the control the 16px default instead.
				if (!px) return null;
				// An arbitrary font size sets no line height of its own, so the
				// inherited factor applies to the new size.
				font = Number(px[1]);
				line = undefined;
				continue;
			}
			// Anything else under `text-` is a colour or an alignment.
			continue;
		}
		const leading = bare.match(/^leading-(.+)$/);
		if (!leading) continue;
		const factor = LEADING_FACTORS[leading[1]];
		if (factor !== undefined) {
			leadingFactor = factor;
			continue;
		}
		if (/^\d+(?:\.\d+)?$/.test(leading[1])) {
			line = Number(leading[1]) * SPACING_UNIT;
			leadingFactor = undefined;
			continue;
		}
		return null;
	}
	const inherited = font === undefined;
	const basis = font ?? 16;
	if (leadingFactor !== undefined)
		return { px: basis * leadingFactor, inherited };
	if (line !== undefined) return { px: line, inherited };
	return { px: inherited ? INHERITED_LINE_BOX : basis * 1.5, inherited };
}

/**
 * The tokens of a class list the hit-area rule has nothing to say about, or
 * null if it does: an overlay clears both floors, and a height or a stretch
 * token is a number `hitAreaFault` already holds the control to.
 */
function unreachableTokens(classes: string): string[] | null {
	const { tokens, declared, stretched } = measure(classes);
	if (tokens.includes("touch-target") || declared.h || stretched.h) return null;
	return tokens;
}

/**
 * The height a control implies when it states none: its line box plus its
 * vertical padding. Null when the control is not in that shape, or when its
 * type is unreadable.
 *
 * This is the arithmetic the guard cannot demand. `hitAreaFault` speaks only
 * about numbers a control wrote down, because a text control's height is its
 * text's business — but `padding + line box` is exactly the part of that
 * business a class list does spell out. Computing it is what turns "so many
 * controls are in that shape" from a number someone counts by hand every year
 * or so into one the scan re-derives on every run. See `deferredControls`,
 * which is what the census is built from.
 *
 * Padding counts even on a tag CSS leaves `inline`, where a stated `height`
 * would be dropped: an inline box's padding is still painted and still takes
 * the tap, and this is a hit area rather than a line box.
 *
 * Borders are left out. `border-2` is a width and `border-th-border` is a
 * colour, and telling them apart needs the palette; omitting them reads a
 * control as shorter than it renders, which is the direction that over-reports
 * rather than excuses.
 *
 * Two padding tokens on one axis are read as the larger, not as the cascade:
 * `p-4 py-1` renders with 8px of vertical padding and is read here as 32, and
 * `pt-2 pb-2` renders with 16 and is read as 8. Only the first of those excuses
 * a control instead of alarming about it, and nothing writes either shape
 * today. Reading it properly means ordering tokens by specificity, and a class
 * list that says two things about one axis is a bug of its own.
 */
export function impliedHeight(classes: string): ImpliedHeight | null {
	const tokens = unreachableTokens(classes);
	if (!tokens) return null;
	const box = lineBox(tokens);
	if (!box) return null;
	let fine = 0;
	let coarse = 0;
	for (const token of tokens) {
		const pad = paddingPx(token);
		if (!pad) continue;
		const px = pad.px * pad.edges;
		coarse = Math.max(coarse, px);
		if (!/(?:^|:)pointer-coarse:/.test(token)) fine = Math.max(fine, px);
	}
	return {
		fine: box.px + fine,
		coarse: box.px + coarse,
		inherited: box.inherited,
	};
}

/**
 * A control whose height the guard cannot demand, with the height it implies.
 *
 * The line number is kept even though `renderCensus` drops it: dropping it is a
 * decision about what the register is sensitive to, not about what was found,
 * and a caller that wants to go and look at one of these needs it.
 */
export interface Deferred extends ImpliedHeight {
	file: string;
	line: number;
}

/**
 * Every control the hit-area rule cannot reach: it renders text, carries no
 * `touch-target`, and states no height — neither a number nor a token handing
 * the height to its parent.
 *
 * The shortest branch wins, for the same reason `hitAreaFault` fails on the
 * worst one: which branch a call site takes is decided by arguments this scan
 * does not evaluate.
 *
 * A control whose type is unreadable is returned with `fine: 0`, so it cannot
 * be lost — the census counts those separately and expects none.
 */
export function deferredControls(controls: Control[]): Deferred[] {
	const out: Deferred[] = [];
	for (const control of controls) {
		if (control.iconOnly) continue;
		let worst: ImpliedHeight | null = null;
		let unreadable = false;
		for (const classes of control.classes) {
			if (!unreachableTokens(classes)) continue;
			const implied = impliedHeight(classes);
			if (!implied) {
				unreadable = true;
				continue;
			}
			if (!worst || implied.fine < worst.fine) worst = implied;
		}
		if (unreadable) {
			out.push({
				file: control.file,
				line: control.line,
				fine: 0,
				coarse: 0,
				inherited: false,
			});
			continue;
		}
		if (worst) out.push({ ...worst, file: control.file, line: control.line });
	}
	return out;
}

/**
 * The register of everything the hit-area rule cannot reach, as text.
 *
 * It is written into docs/responsive-ui.md and compared there on every run, so
 * the counts in that section are derived rather than remembered. That is the
 * whole point of computing heights: four times in a row this number was
 * corrected to the previous value plus one, because nobody re-counts dozens of
 * controls by hand, and the section had four prose copies for a correction to
 * miss. Nothing outside the generated block may restate a count — one
 * representation, checked.
 *
 * Deliberately no line numbers, and files rather than controls: a line number
 * would make an unrelated edit above a button turn this red, and the register
 * exists to catch a control being *added* to this shape, not moved.
 *
 * The listed px is the fine-pointer height, while the coarse floor is counted
 * against the coarse one — each floor judged on the height that applies to it.
 * The two differ only for padding written behind `pointer-coarse:`, which
 * nothing does today; if something did, the listing would name the shorter of
 * its two heights, which is the alarming direction rather than the excusing
 * one.
 */
export function renderCensus(deferred: Deferred[]): string {
	// A real line box is never zero, so `fine: 0` is unambiguously the "could not
	// be read" marker `deferredControls` sets, and those are kept out of the
	// ranges rather than dragging a 0 into one.
	const unreadable = deferred.filter((d) => d.fine === 0);
	const exact = deferred.filter((d) => d.fine > 0 && !d.inherited);
	const bound = deferred.filter((d) => d.fine > 0 && d.inherited);
	const readable = [...exact, ...bound];
	const range = (group: Deferred[]) =>
		group.length === 0
			? "none"
			: `${Math.min(...group.map((d) => d.fine))}–${Math.max(...group.map((d) => d.fine))}px`;

	const tally = new Map<string, number>();
	for (const d of deferred) {
		const basis = d.fine === 0 ? "unread" : d.inherited ? "bound " : "exact ";
		const key = `${String(d.fine).padStart(4)}px  ${basis} ${d.file}`;
		tally.set(key, (tally.get(key) ?? 0) + 1);
	}
	const listing = [...tally]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([key, n]) => (n > 1 ? `${key} ×${n}` : key));

	return [
		`${deferred.length} controls render text, state no height of their own and carry no touch-target.`,
		"",
		`${exact.length} state their own font size, so the height below is exact: ${range(exact)}.`,
		`${bound.length} inherit it, so the height below is an upper bound — the ancestor that`,
		`  sets it may well set a smaller one: ${range(bound)}.`,
		"",
		`${readable.filter((d) => d.fine < FINE_FLOOR).length} are under the ${FINE_FLOOR}px fine-pointer floor.`,
		`${readable.filter((d) => d.coarse >= COARSE_FLOOR).length} reach the ${COARSE_FLOOR}px coarse floor, ${exact.filter((d) => d.coarse >= COARSE_FLOOR).length} of them on a read height.`,
		`${unreadable.length} state type this scan cannot read, listed as 0px and \`unread\`.`,
		"",
		...listing,
		"",
	].join("\n");
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
