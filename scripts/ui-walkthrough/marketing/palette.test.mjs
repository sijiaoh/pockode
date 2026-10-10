// Run by the Messaging workflow, which watches site/**: a renderer is only
// run by hand, so a token renamed on the site would otherwise go unnoticed
// until the next `run.sh assets`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { painted, tokens } from "./palette.mjs";

const RENDERERS = [
	"stills/architecture.mjs",
	"stills/frames.mjs",
	"stills/render.mjs",
	"stills/social.mjs",
	"video/render.mjs",
	"video/stage.html",
];
const source = (file) => readFileSync(join(import.meta.dirname, file), "utf8");

test("every token a renderer paints with is the site's", () => {
	for (const file of RENDERERS.filter((f) => f !== "stills/frames.mjs"))
		painted(source(file));
});

// docs/marketing-assets.md §1.2.2: colours the site has no token for. One of
// them happens to equal a site token without being it.
const NOT_THE_SITES = { "video/stage.html": ["#22d3ee"] };

// A colour as hex and as the r,g,b an rgb() or rgba() writes it in.
const spellings = (hex) => [
	hex,
	hex
		.slice(1)
		.match(/../g)
		.map((pair) => Number.parseInt(pair, 16))
		.join(","),
];

test("no renderer keeps its own copy of a site colour", () => {
	const colours = [...tokens.values()]
		.map((value) => value.toLowerCase())
		.filter((value) => /^#[0-9a-f]{6}$/.test(value));
	assert.ok(colours.length, "the site's :root has no colour tokens");
	for (const file of RENDERERS) {
		const text = source(file).toLowerCase().replace(/\s+/g, "");
		const copied = colours.filter(
			(colour) =>
				!NOT_THE_SITES[file]?.includes(colour) &&
				spellings(colour).some((spelling) => text.includes(spelling)),
		);
		assert.deepEqual(copied, [], `${file} writes a site colour literally`);
	}
});
