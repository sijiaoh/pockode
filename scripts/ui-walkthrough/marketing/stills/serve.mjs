// What the pages that frame the captures — the stills, the video's stage —
// load from their own made-up origin: the raw captures, the logo and the Geist
// faces. Answered from disk by a route, so no render touches a network.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceScale, VIEWPORTS } from "../../harness.mjs";
import { FONTS } from "../scenes.mjs";

const NODE_MODULES = process.env.WALKTHROUGH_NODE_MODULES;
export const PROJECT_DIR = join(import.meta.dirname, "../../../..");

/** A capture's file name, as the harness names a shot. */
export const captureFile = (state, viewport) =>
	`${state}_${viewport}_abyss-dark.png`;

/** Where a page on `origin` loads that capture from. */
export const captureUrl = (origin, state, viewport) =>
	`${origin}/captures/${encodeURIComponent(captureFile(state, viewport))}`;

/**
 * What is wrong with a capture, if anything. A frame's screen is sized for
 * its capture's viewport, and a capture of any other size — one from an older
 * run, before the viewport changed — would be clipped or leave a gap without
 * an error.
 */
export function captureProblem(captures, state, viewport) {
	const file = join(captures, captureFile(state, viewport));
	if (!existsSync(file)) return `${file} is missing`;
	const vp = VIEWPORTS[viewport];
	const scale = deviceScale(vp);
	const want = [vp.width * scale, vp.height * scale];
	// A PNG's width and height are the IHDR chunk's first two fields.
	const header = readFileSync(file).subarray(16, 24);
	const got = [header.readUInt32BE(0), header.readUInt32BE(4)];
	return got.join() === want.join()
		? undefined
		: `${file} is ${got.join("×")}, not ${want.join("×")}`;
}

function serveAsset(path, captures) {
	if (path.startsWith("/captures/")) {
		const file = join(
			captures,
			decodeURIComponent(path.slice("/captures/".length)),
		);
		return existsSync(file)
			? { contentType: "image/png", body: readFileSync(file) }
			: undefined;
	}
	if (path === "/logo.svg")
		return {
			contentType: "image/svg+xml",
			body: readFileSync(join(PROJECT_DIR, "site/static/images/logo.svg")),
		};
	if (FONTS[path])
		return {
			contentType: "font/ttf",
			body: readFileSync(join(NODE_MODULES, FONTS[path])),
		};
}

/**
 * Answers everything `context` asks of `origin`: `/` with what `page()`
 * returns at the time, `/captures/<file>` out of `captures`, `/logo.svg` and
 * the paths of FONTS; anything else is a 404.
 */
export function routeAssets(context, origin, captures, page) {
	return context.route(`${origin}/**`, (route) => {
		const { pathname } = new URL(route.request().url());
		if (pathname === "/")
			return route.fulfill({ contentType: "text/html", body: page() });
		const found = serveAsset(pathname, captures);
		return found ? route.fulfill(found) : route.fulfill({ status: 404 });
	});
}
