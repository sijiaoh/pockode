// The demo video's storyboard (docs/marketing-assets.md §4.4): one entry per
// shot, in order. A copy edit or a retimed shot is a change here and nowhere
// else; render.mjs lays the shots out and stage.html moves them.
//
// A caption is one line: `code` is set as inline code, **this** in the brand
// gradient. A keyframe names a capture of the marketing suites by its state
// (the part of the file name before the viewport); the element tapped to leave
// it is read from the capture's own sidecar, so it is not repeated here.
// `address` frames a capture as a browser tab showing that host (§3.2).
//
// Shot 4's middle keyframe is the option picked, so that the tap on Send is
// seen before the answer is.

import { PREVIEW_URL } from "../scenes.mjs";

export const FPS = 30;
export const GIF_FPS = 10;

export const SHOTS = [
	{ kind: "title", duration: 1.8 },
	{
		// The terminal alone, then the phone at `enter` seconds into the shot.
		kind: "terminal",
		duration: 3.8,
		caption: "Run `pockode`. **Scan the QR code.**",
		enter: 1.2,
		keyframes: [{ state: "project-empty" }],
	},
	{
		kind: "phone",
		duration: 4.0,
		caption: "**Describe the feature** as a story.",
		keyframes: [
			{ state: "new-story" },
			{ state: "new-story-filled" },
			{ state: "story-new" },
		],
	},
	{
		kind: "desktop",
		duration: 4.8,
		caption: "Agents split it up and **work in parallel.**",
		keyframes: [{ state: "desktop-story" }, { state: "desktop-task" }],
	},
	{
		kind: "phone",
		duration: 4.2,
		caption: "An agent asks — **answer from your phone.**",
		keyframes: [
			{ state: "question" },
			{ state: "question-picked" },
			{ state: "chat-question" },
		],
	},
	{
		kind: "phone",
		duration: 3.8,
		caption: "**Review every change.**",
		keyframes: [{ state: "chat-changes" }, { state: "diff" }],
	},
	{
		kind: "phone",
		duration: 3.2,
		caption: "**Preview** your dev server, live.",
		keyframes: [
			{ state: "preview-sheet" },
			{ state: "preview-page", address: new URL(PREVIEW_URL).host },
		],
	},
	{
		kind: "phone",
		duration: 3.0,
		caption: "**Commit** when it's right.",
		keyframes: [{ state: "commit-sheet" }, { state: "committed" }],
	},
	{ kind: "end", duration: 2.4 },
];

/** The poster: the middle of the question shot's first keyframe. */
export const POSTER = { shot: 4, keyframe: 0 };

// Motion (§4.3), in seconds.
export const MOTION = {
	shotFade: 0.4,
	keyframeFade: 0.25,
	tapLead: 0.3,
	tapLength: 0.45,
	enter: 0.4,
	titleIn: 0.3,
	captionIn: 0.32,
	captionOut: 0.2,
};

/**
 * `t` on the video's frame grid, so a change falls on the frame it is meant to
 * rather than one either side of it by a rounding error.
 */
export const grid = (t) => Math.round(t * FPS) / FPS;

/**
 * Where each shot and each keyframe change falls, in seconds from the start.
 * A keyframe holds for an even share of what is left of its shot once the
 * shot has faded in; `change` is when the next one starts to fade over it.
 */
export function timeline() {
	let start = 0;
	return SHOTS.map((shot, index) => {
		const end = grid(start + shot.duration);
		const keyframes = shot.keyframes ?? [];
		const settled = start + MOTION.shotFade;
		const slot = (end - settled) / keyframes.length;
		const changes = keyframes.map((_, k) =>
			grid(shot.kind === "terminal" ? start + shot.enter : settled + k * slot),
		);
		const timed = { ...shot, index, start, end, changes };
		start = end;
		return timed;
	});
}

export const DURATION = SHOTS.reduce((sum, shot) => sum + shot.duration, 0);
