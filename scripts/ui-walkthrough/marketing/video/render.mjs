// Renders the demo video and its README GIF (docs/marketing-assets.md §4) from
// the captures `run.sh shoot marketing` left in SHOTS_DIR: the storyboard's
// keyframes in their device frames on stage.html, which draws any time `t`;
// each frame is screenshotted and piped to a pinned ffmpeg. Run through
// `run.sh video`, which provides the browser, ffmpeg and the environment this
// reads; it writes demo.mp4, demo.webm, demo.gif and demo-poster.png into
// ASSETS_DIR/video.
//
// The stage has no clock of its own, so the same captures give the same
// frames, and ffmpeg is told to encode them the same way every time: one
// thread and bit-exact output, so no muxer version or random ID in a header.
// The encoder's own settings string stays in the stream, which is why ffmpeg
// is pinned (run.sh).

import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import marketing, { FONT_FACES } from "../scenes.mjs";
import {
	FRAME_CSS,
	PHONE,
	phoneFrame,
	sampleEdges,
	WINDOW,
	windowFrame,
} from "../stills/frames.mjs";
import {
	captureFile,
	captureProblem,
	captureUrl,
	PROJECT_DIR,
	routeAssets,
} from "../stills/serve.mjs";
import {
	DURATION,
	FPS,
	GIF_FPS,
	grid,
	MOTION,
	POSTER,
	timeline,
} from "./storyboard.mjs";

const NODE_MODULES = process.env.WALKTHROUGH_NODE_MODULES;
const require = createRequire(join(NODE_MODULES, "_"));
const { chromium } = require("playwright-core");

const HERE = import.meta.dirname;
const CAPTURES = join(process.env.SHOTS_DIR, marketing.dir);
const OUT = join(process.env.ASSETS_DIR, "video");
const FFMPEG = process.env.WALKTHROUGH_FFMPEG;

// §4.1: the stage and its content band.
const STAGE = { width: 1920, height: 1080 };
const BAND = { top: 54, height: 864, centre: 960 };
// Shot 1: the terminal's place is in stage.html; the phone beside it.
const SHOT1_PHONE = { height: 760, centre: 1460 };
const GIF = { width: 800, height: 450 };
const GIF_LIMIT = 6 * 1024 * 1024;

const ORIGIN = "http://stage.invalid";

// --- the keyframes ----------------------------------------------------------

/**
 * A keyframe's capture and its sidecar, at the viewport its frame is drawn
 * for, refused if it is not that size.
 */
function capture(keyframe, desktop) {
	const viewport = desktop ? WINDOW.viewport : PHONE.viewport(keyframe.address);
	const problem = captureProblem(CAPTURES, keyframe.state, viewport);
	if (problem)
		throw new Error(`${problem}; run \`run.sh shoot marketing\` again.`);
	const sidecar = join(
		CAPTURES,
		captureFile(keyframe.state, viewport).replace(/\.png$/, ".json"),
	);
	return {
		src: captureUrl(ORIGIN, keyframe.state, viewport),
		tap: existsSync(sidecar)
			? JSON.parse(readFileSync(sidecar, "utf8")).tap
			: undefined,
	};
}

/**
 * A framed capture placed on the stage: its markup, and `at`, which maps a
 * point of the capture to the stage.
 */
async function device(page, keyframe, { desktop, ...place } = {}) {
	const shot = capture(keyframe, desktop);
	if (desktop) {
		const scale = BAND.height / WINDOW.height;
		const left = BAND.centre - (WINDOW.width * scale) / 2;
		return {
			...shot,
			html: placed(windowFrame({ src: shot.src }), left, BAND.top, scale),
			at: ({ x, y }) => ({
				x: left + scale * x,
				y: BAND.top + scale * (WINDOW.titleBar + y),
			}),
		};
	}
	const { height = BAND.height, centre = BAND.centre, attrs = "" } = place;
	const scale = height / PHONE.height;
	const left = centre - (PHONE.width * scale) / 2;
	const top = BAND.top + (BAND.height - height) / 2;
	const edges = await sampleEdges(page, shot.src);
	const screen = PHONE.screen(keyframe.address);
	return {
		...shot,
		html: placed(
			phoneFrame({ src: shot.src, edges, address: keyframe.address }),
			left,
			top,
			scale,
			attrs,
		),
		at: ({ x, y }) => ({
			x: left + scale * (screen.x + x),
			y: top + scale * (screen.y + y),
		}),
	};
}

const placed = (html, left, top, scale, attrs = "") =>
	`<div class="device" ${attrs} style="left: ${left}px; top: ${top}px; scale: ${scale}">${html}</div>`;

// --- the terminal -----------------------------------------------------------

/**
 * pockode's own startup banner (§3.3), printed by the real startup package
 * under a pseudo-terminal so that it keeps its colours.
 */
function banner() {
	let version;
	try {
		// The nearest release, not a prerelease: an alpha tag would otherwise
		// change the video, and show a version nobody installs by default.
		version = execFileSync(
			"git",
			["describe", "--tags", "--abbrev=0", "--exclude", "*-*"],
			{
				cwd: PROJECT_DIR,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (err) {
		throw new Error(
			`The banner shows the nearest release tag, and git found none (a shallow clone has none): ${err.stderr}`,
		);
	}
	// Built first, outside the pseudo-terminal: whatever go prints on the way
	// (a module it downloads, an error) is then the run's, not the video's.
	const dir = mkdtempSync(join(tmpdir(), "pockode-banner-"));
	try {
		const bin = join(dir, "banner");
		execFileSync("go", ["build", "-o", bin, "./internal/cmd/marketingbanner"], {
			cwd: join(PROJECT_DIR, "server"),
			stdio: ["ignore", "inherit", "inherit"],
		});
		const out = execFileSync(
			"script",
			["-qec", `'${bin}' '${version.trim().replace(/^v/, "")}'`, "/dev/null"],
			{ encoding: "utf8" },
		);
		if (!out.includes("P O C K O D E") || !out.includes("Scan to connect"))
			throw new Error(`The banner did not come out as expected:\n${out}`);
		// The banner opens with the blank line that parts it from the command.
		return out.replace(/\r/g, "").replace(/\n+$/, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const ANSI = {
	1: "a-bold",
	2: "a-dim",
	32: "a-green",
	33: "a-yellow",
	36: "a-cyan",
	37: "a-white",
};
const GLYPHS = {
	"◆": '<i class="g-diamond"></i>',
	"▸": '<i class="g-tri"></i>',
	"█": '<i class="q q-full"></i>',
	"▀": '<i class="q q-top"></i>',
	"▄": '<i class="q q-bot"></i>',
};
const escapeHtml = (s) =>
	s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** The banner's ANSI colours as spans, its QR rows as rows of cells. */
function ansiToHtml(text) {
	return text
		.split("\n")
		.map((line) => {
			let classes = [];
			let html = "";
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC opens an ANSI sequence.
			for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: as above.
				const sgr = part.match(/^\x1b\[([\d;]*)m$/);
				if (sgr) {
					for (const code of sgr[1].split(";").map(Number)) {
						if (code !== 0 && !ANSI[code])
							throw new Error(`The banner uses an unmapped colour, ${code}.`);
						classes = code === 0 ? [] : [...classes, ANSI[code]];
					}
					continue;
				}
				if (!part) continue;
				// Anything else past ASCII may not be in Geist Mono, and would be
				// drawn in whichever font the machine falls back to.
				const body = [...part]
					.map((c) => {
						if (GLYPHS[c]) return GLYPHS[c];
						if (c > "~")
							throw new Error(
								`The banner prints ${c}, which nothing here draws.`,
							);
						return escapeHtml(c);
					})
					.join("");
				html += classes.length
					? `<span class="${classes.join(" ")}">${body}</span>`
					: body;
			}
			return /[█▀▄]/.test(line)
				? `<span class="qr">${html}</span>`
				: `${html}\n`;
		})
		.join("");
}

const terminal = () => `<div class="terminal">
	<div class="terminal-title">~/tidy — pockode</div>
	<pre><span class="a-dim">$</span> pockode --password ••••••••
${ansiToHtml(banner())}</pre>
</div>`;

// --- the cards and captions -------------------------------------------------

const titleCard = () => `<div class="card" data-fade-in="0">
	<img src="${ORIGIN}/logo.svg" width="120" height="120" />
	<div class="title-name">Pockode</div>
	<div class="title-sub">Code from your pocket</div>
</div>`;

const endCard = () => `<div class="card">
	<img src="${ORIGIN}/logo.svg" width="96" height="96" />
	<div class="end-name">Pockode</div>
	<div class="end-install">curl -fsSL https://pockode.com/install.sh | sh</div>
	<div class="end-foot">pockode.com · Open source</div>
</div>`;

/** `code` and **highlight** (storyboard.mjs) as markup. */
const caption = (text) =>
	escapeHtml(text)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

// --- the stage --------------------------------------------------------------

/** Everything stage.html's `build` takes (see there). */
async function stageData(page) {
	const shots = timeline();
	const layers = [];
	const captions = [];
	const taps = [];
	let step = 0;
	for (const shot of shots) {
		const from = shot.start;
		const fade = shot.index === 0 ? 0 : MOTION.shotFade;
		if (shot.kind === "title") layers.push({ html: titleCard(), from, fade });
		else if (shot.kind === "end") layers.push({ html: endCard(), from, fade });
		else if (shot.kind === "terminal") {
			const phone = await device(page, shot.keyframes[0], {
				...SHOT1_PHONE,
				attrs: `data-enter="${shot.changes[0]}"`,
			});
			layers.push({ html: terminal() + phone.html, from, fade });
		} else {
			const devices = [];
			for (const keyframe of shot.keyframes)
				devices.push(
					await device(page, keyframe, { desktop: shot.kind === "desktop" }),
				);
			devices.forEach((d, k) => {
				layers.push(
					k === 0
						? { html: d.html, from, fade }
						: {
								html: d.html,
								from: shot.changes[k],
								fade: MOTION.keyframeFade,
							},
				);
				const next = shot.changes[k + 1];
				if (next === undefined) return;
				// Every keyframe is left by a tap: without its sidecar the video
				// would cut on nothing, so the scene has to record one.
				if (!d.tap)
					throw new Error(
						`${shot.keyframes[k].state} has no tap sidecar; give its shot() a \`tap\` and run \`run.sh shoot marketing\` again.`,
					);
				taps.push({ ...d.at(d.tap), at: grid(next - MOTION.tapLead) });
			});
		}
		if (shot.caption)
			captions.push({
				html: caption(shot.caption),
				start: shot.start,
				end: shot.end,
				step: step++,
			});
	}
	const steps = shots.filter((s) => s.caption);
	return {
		motion: MOTION,
		steps: steps.length,
		layers,
		captions,
		taps,
		dots: { from: steps[0].start, to: steps.at(-1).end },
	};
}

// --- encoding ---------------------------------------------------------------

// Bit-exact and single-threaded (§1.4): no encoder version or random ID in the
// headers, and no split of the work that could differ between machines.
const EXACT = [
	"-fflags",
	"+bitexact",
	"-flags:v",
	"+bitexact",
	"-threads",
	"1",
];
const input = (fps) => [
	"-hide_banner",
	"-loglevel",
	"error",
	"-filter_threads",
	"1",
	"-f",
	"image2pipe",
	"-framerate",
	String(fps),
	"-c:v",
	"png",
	"-i",
	"-",
];

function ffmpeg(fps, args, file) {
	const child = spawn(
		FFMPEG,
		[
			...input(fps),
			...args,
			...EXACT,
			"-map_metadata",
			"-1",
			"-an",
			"-y",
			file,
		],
		{ stdio: ["pipe", "inherit", "inherit"] },
	);
	const done = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`ffmpeg exited ${code} writing ${file}`)),
		);
	});
	// An ffmpeg that dies mid-stream breaks the pipe; its exit says why, so a
	// write waits on that rather than on a drain that will never come.
	child.stdin.on("error", () => {});
	done.catch(() => {});
	return {
		write: (frame) =>
			child.stdin.write(frame)
				? undefined
				: Promise.race([
						new Promise((resolve) => child.stdin.once("drain", resolve)),
						done,
					]),
		end: () => {
			child.stdin.end();
			return done;
		},
	};
}

const MP4 = [
	"-c:v",
	"libx264",
	"-profile:v",
	"high",
	"-pix_fmt",
	"yuv420p",
	"-crf",
	"20",
	"-movflags",
	"+faststart",
];
const WEBM = [
	"-c:v",
	"libvpx-vp9",
	"-pix_fmt",
	"yuv420p",
	"-crf",
	"32",
	"-b:v",
	"0",
	"-row-mt",
	"0",
];
const GIF_ARGS = [
	"-vf",
	`scale=${GIF.width}:${GIF.height}:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
	"-loop",
	"0",
];

/**
 * Screenshots every frame at `fps` into each of `sinks`. A frame whose stage
 * is in the state the last one was — most of them: a keyframe holds — is the
 * last one's screenshot again rather than a new one.
 */
async function frames(page, fps, cut, sinks, onFrame) {
	const count = Math.round(DURATION * fps);
	let last;
	let frame;
	for (let i = 0; i < count; i++) {
		const state = await page.evaluate(
			([t, cut]) => window.seek(t, cut),
			[i / fps, cut],
		);
		if (state !== last) frame = await page.screenshot({ type: "png" });
		last = state;
		onFrame?.(i, frame);
		await Promise.all(sinks.map((sink) => sink.write(frame)));
		if (i % fps === 0)
			process.stdout.write(`\r${i / fps}s / ${DURATION.toFixed(1)}s`);
	}
	process.stdout.write("\n");
	await Promise.all(sinks.map((sink) => sink.end()));
}

// --- the run ----------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: marketing.browserArgs });
try {
	const context = await browser.newContext({
		viewport: STAGE,
		deviceScaleFactor: 1,
	});
	const stage = readFileSync(join(HERE, "stage.html"), "utf8").replace(
		"/* FONT_FACES, FRAME_CSS */",
		FONT_FACES + FRAME_CSS,
	);
	await routeAssets(context, ORIGIN, CAPTURES, () => stage);
	const page = await context.newPage();
	await page.goto(`${ORIGIN}/`);
	await page.evaluate((data) => window.build(data), await stageData(page));

	// The middle of the poster's keyframe: from its change (or its shot's
	// start) to the next one (or its shot's end).
	const poster = timeline()[POSTER.shot];
	const from = POSTER.keyframe ? poster.changes[POSTER.keyframe] : poster.start;
	const to = poster.changes[POSTER.keyframe + 1] ?? poster.end;
	const posterAt = Math.round(((from + to) / 2) * FPS);
	const path = (name) => join(OUT, name);

	console.log("Rendering demo.mp4 and demo.webm...");
	await frames(
		page,
		FPS,
		false,
		[ffmpeg(FPS, MP4, path("demo.mp4")), ffmpeg(FPS, WEBM, path("demo.webm"))],
		(i, frame) => {
			if (i === posterAt) writeFileSync(path("demo-poster.png"), frame);
		},
	);
	console.log("Rendering demo.gif...");
	await frames(page, GIF_FPS, true, [
		ffmpeg(GIF_FPS, GIF_ARGS, path("demo.gif")),
	]);
	for (const name of ["demo.mp4", "demo.webm", "demo.gif", "demo-poster.png"])
		console.log(
			`${path(name)} (${(statSync(path(name)).size / 1024 / 1024).toFixed(2)} MB)`,
		);
	// The lever, if it ever is too big, is the GIF's frame rate, then its size
	// (§4.6) — not a quieter failure.
	const gif = statSync(path("demo.gif")).size;
	if (gif > GIF_LIMIT) {
		console.error(
			`demo.gif is ${(gif / 1024 / 1024).toFixed(2)} MB, over the 6 MB the README can carry.`,
		);
		process.exitCode = 1;
	}
} finally {
	await browser.close();
}
