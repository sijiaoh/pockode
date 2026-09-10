import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOTS, repoPath, sourceFiles } from "./sourceScan";

// Hover can only ever *add*. A control hidden by one condition and restored by
// `hover:` is permanently hidden wherever hovering does not exist — and Tailwind
// compiles `hover:` inside `@media (hover: hover)`, so on a touch screen the
// restoring half is not merely unused, it is absent from the stylesheet.
//
// That shape is how sessions, worktrees and the file-entry `…` menu became
// undeletable on a tablet: they were gated on viewport *width*, which says
// nothing about whether a pointer can hover. The gate has to be `pointer-fine`,
// and both halves have to sit behind it so a coarse pointer gets neither and
// the control simply stays visible. See docs/responsive-ui.md.
//
// A per-component test could not catch this: the bug is a class list that never
// matches, so the component renders "correctly" in jsdom either way. What has
// to hold is a property of the source, and it has to hold for components not
// written yet — hence a scan rather than an assertion per call site.

const WIDTH_PREFIXES = ["sm", "md", "lg", "xl", "2xl"];

/** Utilities that decide whether a control can be seen or hit at all. */
const VISIBILITY =
	"hidden|block|inline-block|inline-flex|flex|grid|invisible|visible|opacity-0|opacity-100|pointer-events-none|pointer-events-auto";

/** Utilities that take a control away. A literal with none of these hides nothing. */
const HIDER =
	/(?:^|\s|")((?:[\w.-]+:)*)(hidden|invisible|opacity-0|pointer-events-none)(?=\s|"|$)/g;

/** e.g. `pointer-fine:group-hover:opacity-100` -> gate `pointer-fine:`. */
const REVEAL = new RegExp(
	`(?:^|\\s|")((?:[\\w.-]+:)*?)(?:group-)?(?:hover|group-focus-within|focus-within):(${VISIBILITY})(?=\\s|"|$)`,
	"g",
);

/**
 * Class lists live in string literals; a template literal splits into several.
 *
 * Both halves of a reveal pair have to land in the same literal for the checks
 * below to see them — which is also how they should be written, since a pair
 * split across two literals is unreadable. Deliberately a loose pre-filter:
 * anything narrower silently drops literals with stacked prefixes
 * (`dark:pointer-fine:group-hover:…`) and turns a violation into a pass.
 */
function classLiterals(source: string): string[] {
	return (source.match(/"[^"\n]*"|`[^`]*`/g) ?? []).filter((lit) =>
		/(?:hover|focus-within):/.test(lit),
	);
}

interface Violation {
	file: string;
	literal: string;
	reason: string;
}

function inspect(file: string): Violation[] {
	const source = readFileSync(file, "utf8");
	const rel = repoPath(file);
	const found: Violation[] = [];

	for (const literal of classLiterals(source)) {
		const reveals = [...literal.matchAll(REVEAL)];
		if (reveals.length === 0) continue;

		for (const [, gate] of reveals) {
			const widthGated = WIDTH_PREFIXES.some((p) => gate.includes(`${p}:`));
			if (widthGated) {
				found.push({
					file: rel,
					literal,
					reason: `hover-revealed visibility gated on viewport width (\`${gate}\`); width does not imply a hover-capable pointer — use \`pointer-fine:\``,
				});
			}
		}

		// Both halves must share one gate. A hider behind a different gate (or
		// none) survives on a device where the reveal was compiled away.
		// `hover:hidden` and friends are the reveal side of the pair, not hiders;
		// counting them would report the same token twice under both roles.
		const hiders = [...literal.matchAll(HIDER)].filter(
			([, gate]) => !/(?:hover|focus-within):$/.test(gate),
		);
		if (hiders.length === 0) continue;
		const gates = new Set(reveals.map(([, gate]) => gate));
		for (const [, hiderGate, util] of hiders) {
			if (!gates.has(hiderGate)) {
				found.push({
					file: rel,
					literal,
					reason: `hidden behind \`${hiderGate || "(no gate)"}\` but revealed behind \`${[...gates].map((g) => g || "(no gate)").join("`, `")}\` — the two halves must share one gate, or the control never comes back`,
				});
				continue;
			}

			// `display: none` takes the control out of the tab order, so no amount
			// of focus-within can hand it back — a keyboard user on a hovering
			// pointer would lose it entirely. Opacity keeps it focusable, and keeps
			// the row from reflowing when it appears.
			if (util === "hidden") {
				found.push({
					file: rel,
					literal,
					reason: `hover reveal hides with \`${hiderGate}hidden\`; \`display\` drops it from the tab order — hide with \`opacity-0\` instead`,
				});
			}

			// Fixing touch must not cost the keyboard: on a hovering pointer the
			// control is invisible until focus moves into the group, so the hover
			// reveal needs a focus-within twin behind the very same gate.
			if (util === "opacity-0" || util === "invisible") {
				const focusTwin = new RegExp(
					`(?:^|\\s|")${hiderGate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}group-focus-within:`,
				);
				if (!focusTwin.test(literal)) {
					found.push({
						file: rel,
						literal,
						reason: `hidden by \`${hiderGate}${util}\` and revealed only on hover — a keyboard user never gets it back; add \`${hiderGate}group-focus-within:opacity-100\``,
					});
				}
			}
		}
	}
	return found;
}

describe("hover reveal", () => {
	const files = ROOTS.flatMap(sourceFiles);

	it("never gates a hover reveal on viewport width, and always pairs it", () => {
		const violations = files.flatMap(inspect);
		expect(
			violations.map((v) => `${v.file}\n  ${v.reason}\n  ${v.literal}`),
		).toEqual([]);
	});
});
