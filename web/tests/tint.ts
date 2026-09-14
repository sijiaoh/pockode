import { type ClassBindings, classSites } from "./classScan";
import { repoPath, sourceFiles } from "./sourceScan";

/**
 * Translucent fills and the text written on top of them, read out of the
 * components rather than listed.
 *
 * A `bg-th-accent/10` is not a colour the stylesheet holds. It is one the
 * compositor makes out of the accent, an alpha, and whatever opaque background
 * the element happens to sit on — so nothing in contrast.ts can see it, and the
 * pairs it guards are all fills a theme pinned a foreground to. Every chip in
 * the app is the other shape.
 *
 * Lives outside `src` for the same reason sourceScan.ts does: reading files
 * needs Node types the app project deliberately does not have.
 */

/**
 * The fills whose tints are guarded. The one hand-written list in this file —
 * everything else about a usage is read off the source.
 *
 * Only the accent, for now, and not because the others are fine. The same scan
 * with `th-error`, `th-warning`, `th-success` and `th-text-muted` added finds
 * eighteen more call sites, and they fail: in every light variant those tokens
 * are below AA as text on their own tint, several of them by more than the
 * accent ever was. That is a token-layer fault — those colours miss the floor
 * as text, as a border and as an icon, over any background — and adding the
 * line here turns the suite red until someone picks new colours, which is a
 * separate piece of work with a judgement call in it. Same reasoning, and same
 * shape, as the survey deliberately left out of `GUARDED_PAIRS`.
 */
export const TINTED_BACKGROUNDS = ["th-accent"];

/**
 * The opaque backgrounds a tint may be composited over.
 *
 * Which one a given chip actually sits on is not decidable from its class list:
 * the backdrop is set by an ancestor in another file, or by two of them. So
 * every tint is checked against all three, and has to clear the floor on each.
 * That is the safe direction to be wrong in — it asks a chip to be readable on
 * a surface it may never land on — and it is what makes the rule hold when a
 * panel's background changes under a chip nobody thought to re-check.
 *
 * Discovered per stylesheet from the variant that declares them, so a theme
 * added later is covered; only the names are written here, because "the page
 * backgrounds" is not something the stylesheet says about itself.
 */
export const BASE_BACKGROUNDS = [
	"th-bg-primary",
	"th-bg-secondary",
	"th-bg-tertiary",
];

/**
 * The most opaque a guarded tint may be.
 *
 * Not a contrast floor — `text-th-text-primary` still clears AA at /30. It is
 * the ceiling that keeps a full-strength accent icon or border legible *on* the
 * tint, which is where the rule puts the hue once the text has gone back to the
 * body colour: the accent against its own /20 composite holds WCAG's non-text
 * 3:1 in every variant and over every base, and against /30 it does not.
 * Capping the alpha keeps that one rule readable — "accent on an accent tint is
 * fine" — instead of splitting it by how strong the tint happens to be.
 */
export const MAX_TINT_ALPHA = 20;

/**
 * Foregrounds a guarded tint may not carry, whatever the arithmetic says.
 *
 * The rule is that text on an accent tint is the body colour; these three are
 * the ways it was written before. Two of them the ratio catches on its own —
 * `th-accent` on its own tint is below AA in every light variant, `th-text-muted`
 * is below it everywhere. `th-accent-hover` is the one that needs saying: it
 * clears 4.5 at /10 by about a third of a point and at /15 by seven hundredths
 * of one, and misses it at /20, so a check that only computed ratios would wave
 * through a chip that a single palette tweak turns illegible, and would have no
 * answer at all to "why not this one, it passes".
 *
 * A ban rather than an allow-list of the one token the rule names, because the
 * arithmetic is the part that has to keep working: an allow-list would make
 * every ratio below a foregone conclusion, and the ratios are what catch a
 * theme changing its colours under text nobody re-checked.
 */
export const BANNED_FOREGROUNDS = [
	"th-accent",
	"th-accent-hover",
	"th-text-muted",
];

/** A fill, its alpha, and a foreground token sharing the same element. */
export interface TintUsage {
	/** Custom property names without the leading `--`. */
	background: string;
	/** Tailwind's opacity step, 0-100, as written. */
	alpha: number;
	foreground: string;
	/** Every `file:line` writing this combination, for the failure message. */
	sites: string[];
}

/** An opacity step written on a guarded fill, and where. */
export interface TintAlpha {
	alpha: number;
	sites: string[];
}

/** Variant prefixes (`hover:`, `focus-visible:`, `group-hover:`) lead a class. */
const PREFIX = "(?:[\\w-]+:)*";

/**
 * Every translucent fill written under `root`: the alphas on their own, and the
 * foregrounds sharing an element with one.
 *
 * The two come back together because they are one walk over the same files —
 * and because the alphas have to be collected even where no foreground is,
 * which is what keeps the alpha ceiling a fact about the app rather than about
 * the chips that happen to spell their text colour out.
 *
 * Both halves are read with their variant prefixes stripped, and every fill on
 * an element is paired with every foreground on it. That over-pairs in
 * principle — a `hover:bg-th-accent/10` beside a `group-hover:text-th-error`
 * would be read as a pair neither state produces alone, and a `className` with
 * more branch combinations than the expansion enumerates has its overflow
 * folded into one list, which mixes branches that exclude each other. But the
 * alternative under-pairs, and under-pairing is how this rule was broken in the
 * first place: five of the call sites that failed AA failed only in a transient
 * state, `hover:` and `active:` fills under a resting `text-th-accent`. A scan
 * that read the resting state only would have called every one of them green.
 *
 * What it does not see, said plainly: an element that carries the tint and
 * nothing else, its text coming from a child or from the cascade. Nine of
 * today's tinted elements are that shape (a selected row, a drop target) and
 * all of them are fine, but it is a person who checked that, not this file.
 * Pairing across elements means resolving the DOM, which a text scan cannot do.
 */
export function scanTints(
	root: string,
	helpers: ClassBindings,
): { usages: TintUsage[]; alphas: TintAlpha[] } {
	const fill = new RegExp(
		`^${PREFIX}bg-(${TINTED_BACKGROUNDS.join("|")})\\/(\\d+)$`,
	);
	const text = new RegExp(`^${PREFIX}text-(th-[\\w-]+)$`);

	const usages = new Map<string, TintUsage>();
	const alphas = new Map<number, string[]>();
	/** Sites are listed in a message, so the same element is only named once. */
	const note = (sites: string[], where: string) => {
		if (!sites.includes(where)) sites.push(where);
	};

	for (const file of sourceFiles(root)) {
		for (const site of classSites(file, helpers)) {
			const where = `${repoPath(file)}:${site.line}`;
			for (const classes of site.classes) {
				const tokens = classes.split(/\s+/).filter(Boolean);
				const fills = tokens
					.map((t) => fill.exec(t))
					.filter((m): m is RegExpExecArray => m !== null);
				if (fills.length === 0) continue;
				const foregrounds = new Set(
					tokens
						.map((t) => text.exec(t)?.[1])
						.filter((t): t is string => t !== undefined),
				);
				for (const [, background, step] of fills) {
					const alpha = Number(step);
					const seen = alphas.get(alpha) ?? [];
					note(seen, where);
					alphas.set(alpha, seen);
					for (const foreground of foregrounds) {
						const key = `${background}/${alpha} ${foreground}`;
						const usage = usages.get(key) ?? {
							background,
							alpha,
							foreground,
							sites: [],
						};
						note(usage.sites, where);
						usages.set(key, usage);
					}
				}
			}
		}
	}
	return {
		usages: [...usages.values()],
		alphas: [...alphas].map(([alpha, sites]) => ({ alpha, sites })),
	};
}
