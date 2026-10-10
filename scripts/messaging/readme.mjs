// Writes the README's messaging blocks from site/data/messaging.yaml, or with
// --check fails when they have drifted from it.
//
// Each block sits between `<!-- messaging:NAME -->` and
// `<!-- /messaging:NAME -->`, each marker on a line of its own; everything
// outside the markers is hand-written and left alone. A marker keeps its own
// indentation, which is what lets one sit between list items without ending
// the list.

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "../..");
const SOURCE = join(ROOT, "site/data/messaging.yaml");
const README = join(ROOT, "README.md");

/** "A, B and C" — the README's list style, no serial comma. */
const joinAnd = (items) =>
	items.length < 2
		? items.join("")
		: `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** A value as an HTML attribute's text, for the README's `<img>` tags. */
const attr = (text) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;");

/** The paths are the README's own; only the alt text comes from the source. */
const img = (src, alt, width) =>
	`<img src="site/static/${src}" alt="${attr(alt)}" width="${width}">`;

/** The README's screenshot grid: rows of file names in images.screenshots. */
const SCREENSHOT_ROWS = [
	["phone-story", "phone-question"],
	["phone-diff", "phone-preview"],
];

const BLOCKS = {
	logo: (m) => [img("images/logo.svg", m.name, 96)],
	tagline: (m) => [`**${m.tagline}**`, "", m.subtitle],
	demo: (m) => [img("marketing/video/demo.gif", m.images.demo, 800)],
	quickstart: (m) => [
		m.quickstart.prerequisite,
		"",
		...m.quickstart.installers.flatMap((i) => [
			`**${i.label}**`,
			"",
			`\`\`\`${i.shell}`,
			"# Install",
			i.install,
			"",
			`# Run (${m.quickstart.run_where})`,
			i.run,
			"```",
			"",
		]),
		m.quickstart.next,
	],
	platforms: (m) => [
		`Runs on ${joinAnd(m.platforms.map((p) => `${p.name} (${p.arch})`))}.`,
	],
	pillars: (m) => m.pillars.map((p) => `- **${p.title}** — ${p.description}`),
	screenshots: (m) => [
		"<table>",
		...SCREENSHOT_ROWS.flatMap((row) => [
			"  <tr>",
			...row.map((name) => {
				const alt = m.images.screenshots[name];
				if (!alt)
					throw new Error(
						`${relative(ROOT, SOURCE)} has no images.screenshots alt text for ${name}.`,
					);
				return `    <td>${img(`marketing/screenshots/${name}.png`, alt, 240)}</td>`;
			}),
			"  </tr>",
		]),
		"</table>",
	],
	license: (m) => [
		`- **License** — ${m.license.label} under the [${m.license.name}](${m.license.file}). ${m.license.summary}`,
	],
};

const MARKER = /^(\s*)<!-- (\/?)messaging:([\w-]+) -->\s*$/;

/** The README with every messaging block rendered from `messaging`. */
export function render(readme, messaging) {
	const out = [];
	const seen = new Set();
	let open = null;
	readme.split("\n").forEach((line, index) => {
		const where = `README.md:${index + 1}`;
		const marker = line.match(MARKER);
		if (!marker) {
			if (!open) out.push(line);
			return;
		}
		const [, , closing, name] = marker;
		if (closing) {
			if (open !== name)
				throw new Error(
					`${where} closes messaging:${name}, which is not open.`,
				);
			out.push(line);
			open = null;
			return;
		}
		if (open)
			throw new Error(
				`${where} opens messaging:${name} inside messaging:${open}.`,
			);
		if (!BLOCKS[name])
			throw new Error(
				`${where} names messaging:${name}; the blocks are ${Object.keys(BLOCKS).join(", ")}.`,
			);
		if (seen.has(name))
			throw new Error(`${where} opens messaging:${name} a second time.`);
		seen.add(name);
		out.push(line, ...BLOCKS[name](messaging));
		open = name;
	});
	if (open) throw new Error(`README.md never closes messaging:${open}.`);
	// A block that lost its markers would otherwise just stop being updated.
	const missing = Object.keys(BLOCKS).filter((name) => !seen.has(name));
	if (missing.length)
		throw new Error(
			`README.md has no markers for ${missing.map((n) => `messaging:${n}`).join(", ")}.`,
		);
	return out.join("\n");
}

if (import.meta.main) {
	const current = readFileSync(README, "utf8");
	const wanted = render(current, parse(readFileSync(SOURCE, "utf8")));
	if (!process.argv.includes("--check")) {
		writeFileSync(README, wanted);
	} else if (wanted !== current) {
		const have = current.split("\n");
		const want = wanted.split("\n");
		const found = want.findIndex((line, i) => line !== have[i]);
		const at = found === -1 ? want.length : found;
		console.error(
			`README.md disagrees with ${relative(ROOT, SOURCE)} at line ${at + 1}:\n` +
				`  README:  ${have[at] ?? "(end of file)"}\n` +
				`  source:  ${want[at] ?? "(end of file)"}\n` +
				"Change the wording in the source, then run `pnpm run readme`.",
		);
		process.exit(1);
	}
}
