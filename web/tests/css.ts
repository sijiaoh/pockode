/**
 * Reading custom properties back out of a stylesheet as text.
 *
 * Two different checks need the same walk — contrast.ts pairs a fill with its
 * foreground, themeTokens.test.ts holds the preview registry to the stylesheet
 * — so the parsing lives here rather than in whichever of them was written
 * first.
 *
 * The walk has no test file of its own: contrast.test.ts exercises it through
 * `themeVariants` — comments holding stray braces, nesting, at-rules, one token
 * that is a prefix of another — and that is where a change to it should be
 * proven.
 *
 * Lives outside `src` for the same reason contrast.ts and sourceScan.ts do:
 * reading the stylesheet as text needs Node types the app project deliberately
 * does not have.
 */

/** Comments are stripped first so a brace or a colon inside one cannot be read as code. */
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The last declaration of `--name` in a rule's own body, matching the cascade,
 * and ignoring both `--color-name` and `var(--name)`.
 */
export function declaration(css: string, name: string): string | undefined {
	const matches = [
		...css.matchAll(new RegExp(`(?:^|[^-\\w])--${name}\\s*:\\s*([^;}]+)`, "g")),
	];
	return matches.at(-1)?.[1].trim();
}

/** How many times `--name` is declared anywhere in the stylesheet. */
export function declarationCount(css: string, name: string): number {
	return (
		stripComments(css).match(new RegExp(`(?:^|[^-\\w])--${name}\\s*:`, "g"))
			?.length ?? 0
	);
}

/**
 * Every style rule in the stylesheet paired with its *own* declarations —
 * at-rule bodies and nested rules walked into, so a theme nested in `@media`
 * or under a parent selector is still found as itself rather than folded into
 * whatever encloses it.
 *
 * At-rules are not returned as rules of their own: `@theme inline` declares
 * `--color-th-accent: var(--th-accent)`, which is the alias layer, not a
 * variant. Statement at-rules (`@import`, `@custom-variant`) are not selectors
 * either, which is why a prelude is cut at its last `;`.
 */
export function styleRules(css: string): { selector: string; body: string }[] {
	const out: { selector: string; body: string }[] = [];

	/** Nesting reads as a descendant here; `&` is the common case and stays readable. */
	const join = (parent: string | undefined, child: string) =>
		parent === undefined ? child : `${parent} ${child}`;

	/** Collects `source`'s own declarations, recursing; pushes them under `selector`. */
	const walk = (source: string, selector: string | undefined) => {
		let own = "";
		let i = 0;
		while (i < source.length) {
			const open = source.indexOf("{", i);
			if (open < 0) {
				own += source.slice(i);
				break;
			}
			let depth = 0;
			let close = open;
			for (; close < source.length; close++) {
				if (source[close] === "{") depth++;
				else if (source[close] === "}" && --depth === 0) break;
			}
			const prelude = source.slice(i, open);
			const cut = prelude.lastIndexOf(";");
			own += prelude.slice(0, cut + 1);
			const prefix = prelude.slice(cut + 1).trim();
			const body = source.slice(open + 1, close);
			// An at-rule keeps the enclosing selector: `@media` inside a theme
			// still declares that theme's tokens.
			walk(body, prefix.startsWith("@") ? selector : join(selector, prefix));
			i = close + 1;
		}
		if (selector !== undefined) out.push({ selector, body: own });
	};

	walk(stripComments(css), undefined);
	return out;
}
