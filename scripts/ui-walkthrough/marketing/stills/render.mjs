// Renders the marketing suite's finished stills (docs/marketing-assets.md
// §§5–7): the framed phone and desktop screenshots, the social image and the
// architecture figure, from the raw captures `run.sh shoot marketing` left in
// SHOTS_DIR. Run through `run.sh stills`, which provides the browser and the
// environment this reads; it writes into ASSETS_DIR in the layout of §9.
//
// Every asset is an HTML page rendered by the headless shell the captures came
// from, with nothing in it that moves or reads the time, so a run over the
// same captures writes the same bytes.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import marketing, { FONT_FACES, PREVIEW_URL } from "../scenes.mjs";
import {
	ARCHITECTURE,
	ARCHITECTURE_THEMES,
	architecturePage,
} from "./architecture.mjs";
import {
	FRAME_CSS,
	PHONE,
	phoneFrame,
	sampleEdges,
	WINDOW,
	windowFrame,
} from "./frames.mjs";
import {
	captureProblem,
	captureUrl,
	PROJECT_DIR,
	routeAssets,
} from "./serve.mjs";
import { SOCIAL, socialPage } from "./social.mjs";

const NODE_MODULES = process.env.WALKTHROUGH_NODE_MODULES;
const require = createRequire(join(NODE_MODULES, "_"));
const { chromium } = require("playwright-core");

const CAPTURES = join(process.env.SHOTS_DIR, marketing.dir);
const OUT = process.env.ASSETS_DIR;

// The pages' own origin, answered by the route below and never by a network.
const ORIGIN = "http://stills.invalid";

/**
 * §7: each framed screenshot, the state of the capture it frames, and — for the page Port
 * Preview opened, a browser tab by nature — the host its address bar shows.
 */
const PHONE_SHOTS = {
	"phone-question": { state: "question" },
	"phone-story": { state: "story-asking" },
	"phone-changes": { state: "chat-changes" },
	"phone-diff": { state: "diff" },
	"phone-commit": { state: "commit-sheet" },
	"phone-preview": {
		state: "preview-page",
		address: new URL(PREVIEW_URL).host,
	},
};
const DESKTOP_SHOT = "desktop-story";

const problems = [
	...Object.values(PHONE_SHOTS).map(({ state, address }) =>
		captureProblem(CAPTURES, state, PHONE.viewport(address)),
	),
	captureProblem(CAPTURES, DESKTOP_SHOT, WINDOW.viewport),
].filter(Boolean);
if (problems.length) {
	console.error(
		`${problems.join("\n")}\nRun \`run.sh shoot marketing\` to take the captures again.`,
	);
	process.exit(1);
}

const html = ({ css, body }) => `<!doctype html>
<html><head><meta charset="utf-8" /><style>
${FONT_FACES}
html, body { margin: 0; }
body { font-family: Geist; }
${FRAME_CSS}
${css}
</style></head><body>${body}</body></html>`;

const browser = await chromium.launch({ args: marketing.browserArgs });

/**
 * Renders a page of `width`×`height` CSS px at `scale` to `file` under OUT.
 * `build` gets the page, already on the origin, to sample what it needs.
 */
async function render(file, { width, height, scale, transparent }, build) {
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: scale,
	});
	let current = "";
	await routeAssets(context, ORIGIN, CAPTURES, () => current);
	const page = await context.newPage();
	await page.goto(`${ORIGIN}/`);
	current = html(await build(page));
	await page.goto(`${ORIGIN}/`);
	await page.evaluate(async () => {
		await Promise.all([
			document.fonts.load("16px Geist"),
			document.fonts.load('16px "Geist Mono"'),
			...[...document.images].map((img) => img.decode()),
		]);
		await document.fonts.ready;
		window.layout?.();
	});
	const path = join(OUT, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		await page.screenshot({
			omitBackground: transparent,
			animations: "disabled",
		}),
	);
	await context.close();
	console.log(path);
}

const phonePage = async (page, { state, address }) => {
	const src = captureUrl(ORIGIN, state, PHONE.viewport(address));
	return {
		css: "",
		body: phoneFrame({
			src,
			edges: await sampleEdges(page, src),
			address,
			left: PHONE.padding,
			top: PHONE.padding,
		}),
	};
};

try {
	for (const [name, shot] of Object.entries(PHONE_SHOTS))
		await render(
			`screenshots/${name}.png`,
			{
				width: PHONE.width + 2 * PHONE.padding,
				height: PHONE.height + 2 * PHONE.padding,
				scale: 2,
				transparent: true,
			},
			(page) => phonePage(page, shot),
		);

	await render(
		"screenshots/desktop.png",
		{
			width: WINDOW.width + 2 * WINDOW.padding,
			height: WINDOW.height + 2 * WINDOW.padding,
			scale: 2,
			transparent: true,
		},
		async () => ({
			css: "",
			body: windowFrame({
				src: captureUrl(ORIGIN, DESKTOP_SHOT, WINDOW.viewport),
				left: WINDOW.padding,
				top: WINDOW.padding,
			}),
		}),
	);

	// The size platforms ask for, and twice it for a hero.
	for (const [file, scale] of [
		["og-image.png", 1],
		["og-image@2x.png", 2],
	])
		await render(file, { ...SOCIAL, scale }, async (page) => {
			const src = captureUrl(
				ORIGIN,
				PHONE_SHOTS["phone-question"].state,
				PHONE.viewport(),
			);
			return socialPage({
				logo: `${ORIGIN}/logo.svg`,
				phone: { src, edges: await sampleEdges(page, src) },
			});
		});

	for (const variant of ARCHITECTURE_THEMES)
		await render(
			`architecture-${variant}.png`,
			{ ...ARCHITECTURE, scale: 2, transparent: true },
			() => architecturePage(variant, PROJECT_DIR),
		);
} finally {
	await browser.close();
}
