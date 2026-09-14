import { readFileSync } from "node:fs";
import { repoPath } from "./sourceScan";

/**
 * Reading a `className` expression back out of a component as text.
 *
 * Two different checks need the same walk — touchTarget.ts asks what box a
 * control states, tint.ts asks which colour tokens end up on the same element
 * — so the expansion lives here rather than in whichever of them was written
 * first, the same move css.ts is.
 *
 * The walk has no test file of its own: touchTarget.test.ts exercises it
 * through `interactiveControls` — nested ternaries, helpers spliced by name,
 * a comment holding an apostrophe, `min-h-[44px]` read as a class and not a
 * subscript — and that is where a change to it should be proven.
 *
 * Lives outside `src` for the same reason sourceScan.ts does: reading files
 * needs Node types the app project deliberately does not have.
 */

/**
 * A name and the text it stands for, plus whether that text is known to be
 * classes.
 *
 * `trusted` is not a shortcut past `looksLikeClasses`, it is the other way of
 * knowing the same thing. A top-level body is a guess — it runs to the next
 * declaration and is matched by shape — so it has to earn its way through that
 * gate. A local `const`'s initialiser was read as a bounded expression and
 * already proved itself class-shaped to be collected at all; putting it through
 * a gate written for the guess would reject a conditional variant on the
 * technicality that it names no layout token (see `localClassConsts`).
 *
 * Carried on the entry rather than passed alongside the map, so the two cannot
 * drift apart: an earlier cut widened the gate itself instead, and that quietly
 * admitted nine bindings that are not classes at all — `SIDEBAR_WIDTH_KEY`, a
 * handful of query keys — to every caller of this module.
 */
export interface ClassBinding {
	body: string;
	trusted: boolean;
}

export type ClassBindings = Map<string, ClassBinding>;

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
export function classHelpers(files: string[]): ClassBindings {
	const out: ClassBindings = new Map();
	const re = /^(?:export\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)\b/gm;
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		const declarations = [...source.matchAll(re)];
		declarations.forEach((m, i) => {
			const body = source.slice(
				m.index,
				declarations[i + 1]?.index ?? source.length,
			);
			out.set(m[1], {
				body: `${out.get(m[1])?.body ?? ""} ${body}`,
				trusted: false,
			});
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
	helpers: ClassBindings,
	seen = new Set<string>(),
): boolean {
	if (seen.has(name)) return false;
	seen.add(name);
	const binding = helpers.get(name);
	if (binding === undefined) return false;
	if (binding.trusted) return true;
	const body = binding.body;
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
const memos = new WeakMap<ClassBindings, Map<string, string[]>>();

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
export function expandVariants(
	expression: string,
	helpers: ClassBindings,
	stack = new Set<string>(),
): string[] {
	const out = new Set<string>();
	for (const variant of alternatives(expression).map(condense)) {
		let texts = [variant];
		for (const name of new Set(variant.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
			if (stack.has(name)) continue;
			const binding = helpers.get(name);
			if (binding === undefined || !looksLikeClasses(name, helpers)) continue;
			texts = cross(texts, helperVariants(name, binding.body, helpers, stack));
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
	helpers: ClassBindings,
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

/**
 * Whether a `const`'s initialiser is a class list and nothing else.
 *
 * Every string it holds has to look like classes — no spaces that are prose,
 * at least one hyphenated token — and it may not call anything. Both halves
 * matter: the name is spliced wherever a `className` mentions it, so a `const
 * label = "Save"` that happened to be quoted past would start contributing
 * classes to a button, and a call could return anything at all.
 */
function isClassInitialiser(text: string): boolean {
	if (text.includes("(")) return false;
	const strings = [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map(
		(m) => m[1] ?? m[2],
	);
	if (strings.length === 0) return false;
	return strings.every((value) => {
		const tokens = value.split(/\s+/).filter(Boolean);
		return (
			tokens.every((t) => /^[\w@[\]:./-]+$/.test(t)) &&
			tokens.some((t) => t.includes("-"))
		);
	});
}

/** The longest initialiser read as a class list; past this it is not one. */
const LOCAL_INITIALISER_LIMIT = 2000;

/**
 * Class lists a component builds into a local `const` before spelling it into
 * a `className`, keyed by name and scoped to the one file.
 *
 * `classHelpers` reads column 0 only, and for good reason — it runs a body to
 * the next top-level declaration, so following indentation would swallow a
 * whole component. This reads the *initialiser* instead, bounded by its own
 * `;`, which is a capture that cannot run away, and that is what lets the local
 * case be read safely. Without it a component that names its variant classes
 * before using them is invisible to every rule built on this scan, and naming
 * them is the normal way to write a conditional style.
 *
 * File-scoped rather than merged into the global map: two components may both
 * call it `variantClass`, and merging would pair one's fill with the other's
 * foreground.
 */
function localClassConsts(source: string): ClassBindings {
	const out: ClassBindings = new Map();
	for (const m of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
		const start = m.index + m[0].length;
		let end = start;
		while (end < source.length && end - start < LOCAL_INITIALISER_LIMIT) {
			const ch = source[end];
			if (ch === ";") break;
			if (
				ch === '"' ||
				ch === "'" ||
				ch === "`" ||
				ch === "(" ||
				ch === "[" ||
				ch === "{"
			) {
				end = atomEnd(source, end);
				continue;
			}
			const comment = commentEnd(source, end);
			end = comment >= 0 ? comment : end + 1;
		}
		const text = source.slice(start, end);
		if (text.length < LOCAL_INITIALISER_LIMIT && isClassInitialiser(text))
			out.set(m[1], { body: text, trusted: true });
	}
	return out;
}

/** One element's `className`, expanded into every class list it can produce. */
export interface ClassSite {
	/** Repo-relative, so a failure names the file the same way git does. */
	file: string;
	/**
	 * Where the `className` is written, which is not always where the offending
	 * class is: a component that builds its variant into a local `const` first
	 * is reported at the attribute that uses it, one hop from the string. The
	 * attribute is the element, and the element is what a rule about two classes
	 * on one element is actually about.
	 */
	line: number;
	/**
	 * One entry per combination of branches the expression and the helpers it
	 * names can take. A rule about what two classes mean together has to hold on
	 * each of them separately: which one an element gets is decided by props
	 * this scan does not evaluate, and merging them would pair a class from one
	 * branch with a class from the branch it excludes.
	 */
	classes: string[];
}

/**
 * Every `className` in a file, whatever tag carries it.
 *
 * `interactiveControls` reads only the tags a finger can activate, because a
 * hit area is a property of a control. A colour pairing is not: the tint that
 * fails AA is as likely to be on a `<span>` label or a `<div>` banner as on a
 * button, so this one takes them all.
 *
 * Matches the attribute rather than walking tags, so a `className` on a
 * component (`<Spinner className=...>`) is read too — it ends up on an element
 * somewhere, and the classes travel with it.
 */
export function classSites(file: string, helpers: ClassBindings): ClassSite[] {
	const source = readFileSync(file, "utf8");
	// Locals layered over the shared map, never into it: see `localClassConsts`.
	const scoped = new Map([...helpers, ...localClassConsts(source)]);
	const out: ClassSite[] = [];
	for (const m of source.matchAll(/className=(?:"([^"]*)"|\{)/g)) {
		const classes =
			m[1] !== undefined
				? [m[1]]
				: expandVariants(
						source.slice(
							m.index + m[0].length,
							atomEnd(source, m.index + m[0].length - 1) - 1,
						),
						scoped,
					);
		out.push({
			file: repoPath(file),
			line: source.slice(0, m.index).split("\n").length,
			classes: [...new Set(classes.map((c) => c.replace(/\s+/g, " ").trim()))],
		});
	}
	return out;
}
