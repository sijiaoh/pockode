// What every suite's scenes share: the server connection, the browser
// helpers, the viewports and themes, and the runner that takes each scene
// through every viewport and theme it is filed under. Run through run.sh,
// which provides the environment this reads.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.WALKTHROUGH_NODE_MODULES, "_"));
const { chromium } = require("playwright-core");

export const BASE_URL = process.env.WALKTHROUGH_URL;
const PASSWORD = process.env.WALKTHROUGH_PASSWORD;
const DATA_DIR = process.env.WALKTHROUGH_DATA_DIR;
const SHOTS_DIR = process.env.SHOTS_DIR;

// Height a phone's soft keyboard takes. The app's viewport meta says
// interactive-widget=resizes-content, so a keyboard shrinks the layout
// viewport exactly as a smaller window does — which is how it is simulated.
const KEYBOARD_HEIGHT = 300;

// A suite lists the names it shoots at.
export const VIEWPORTS = {
	"375x667": { width: 375, height: 667, touch: true },
	"390x844": { width: 390, height: 844, touch: true },
	"375x560": { width: 375, height: 560, touch: true },
	// The narrowest phone in common use; a subagent's Process is indented
	// twice, so this is where its rows run out of room first.
	"360x740": { width: 360, height: 740, touch: true },
	"1440x900": { width: 1440, height: 900, touch: false },
	// The marketing captures (docs/marketing-assets.md §§2–3): a phone's screen
	// less the status bar and home strip its frame draws, and the desktop at a
	// retina density — named apart from 1440x900, so that a filter for one does
	// not take the other too.
	"390x804": { width: 390, height: 804, touch: true },
	"desktop@2x": { width: 1440, height: 900, touch: false, scale: 2 },
	// The page Port Preview opened: the phone less the browser's address bar
	// its frame draws as well (§3.2).
	"390x760": { width: 390, height: 760, touch: true },
};

/** The device pixels per CSS pixel a viewport's shots are taken at. */
export const deviceScale = (vp) => vp.scale ?? (vp.touch ? 2 : 1);

const THEME_NAMES = ["abyss", "aurora", "ember", "mint", "void"];
const MODES = ["light", "dark"];

// --- server side ------------------------------------------------------------

export class Rpc {
	static async connect() {
		const rpc = new Rpc();
		rpc.ws = new WebSocket(`${BASE_URL.replace(/^http/, "ws")}/ws`);
		rpc.nextId = 1;
		rpc.pending = new Map();
		rpc.ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id === undefined || !rpc.pending.has(msg.id)) return;
			const { resolve, reject } = rpc.pending.get(msg.id);
			rpc.pending.delete(msg.id);
			if (msg.error)
				reject(
					new Error(
						`${msg.error.message} ${JSON.stringify(msg.error.data ?? "")}`,
					),
				);
			else resolve(msg.result);
		});
		// A dropped socket fails whatever is still waiting on it, rather than
		// leaving the run hung on a reply that will never come.
		rpc.ws.addEventListener("close", () => {
			for (const { reject } of rpc.pending.values())
				reject(new Error("the server closed the connection"));
			rpc.pending.clear();
		});
		await new Promise((resolve, reject) => {
			rpc.ws.addEventListener("open", resolve, { once: true });
			rpc.ws.addEventListener("error", reject, { once: true });
		});
		rpc.auth = await rpc.call("auth", { password: PASSWORD });
		return rpc;
	}

	call(method, params) {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
	}

	/**
	 * A new chat, titled, whose first message is `content`. `mode` is set before
	 * the message, since the server takes no setting change while a turn is
	 * open; `files` ({ name, type, data }) are uploaded and sent with it, as the
	 * composer does.
	 */
	async session(title, content, { mode, files } = {}) {
		const id = await this.emptySession(title);
		if (mode) await this.call("session.set_mode", { session_id: id, mode });
		const attachments = files ? await this.upload(id, files) : undefined;
		await this.call("chat.message", {
			session_id: id,
			content,
			...(attachments && {
				attachments: attachments.map(({ id, name }) => ({ id, name })),
			}),
		});
		return id;
	}

	/** A new chat, titled, with nothing sent yet. */
	async emptySession(title) {
		const { id } = await this.call("session.create", {});
		await this.call("session.update_title", { session_id: id, title });
		return id;
	}

	async upload(sessionId, files) {
		const body = new FormData();
		for (const { name, type, data } of files)
			body.append("file", new Blob([data], { type }), name);
		const res = await fetch(
			`${BASE_URL}/api/chat/attachments?session_id=${sessionId}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${this.auth.session_token}` },
				body,
			},
		);
		if (!res.ok) throw new Error(`upload: ${res.status} ${await res.text()}`);
		return (await res.json()).files;
	}

	close() {
		this.ws.close();
	}
}

/** Calls a Pockode tool the way an agent's MCP proxy does. */
export async function mcp(name, args) {
	const info = JSON.parse(readFileSync(join(DATA_DIR, "server.json"), "utf8"));
	const res = await fetch(`${BASE_URL}/api/mcp/tools/call`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${info.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ name, arguments: args, caller: {} }),
	});
	const body = await res.json();
	if (!res.ok || body.is_error)
		throw new Error(`${name}: ${body.error ?? body.text}`);
	return body.text;
}

// --- browser side -----------------------------------------------------------

export async function settle(page) {
	// Fonts and the last layout pass; nothing here animates on purpose.
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(250);
}

// Scrolls the scroller nearest to the element so the element is at its top
// (or, with `end`, its bottom at the bottom) — and nothing else.
// Element.scrollIntoView would also scroll every ancestor, a card's
// `overflow-hidden` frame included, which shifts the card's header out of
// view: a state of the driver's making, not the user's.
export async function scrollIntoView(locator, { end = false } = {}) {
	await locator.evaluate((el, end) => {
		let scroller = el.parentElement;
		while (
			scroller &&
			!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
		)
			scroller = scroller.parentElement;
		if (!scroller) return;
		const box = el.getBoundingClientRect();
		const view = scroller.getBoundingClientRect();
		scroller.scrollTop += end
			? box.bottom - view.bottom + 8
			: box.top - view.top - 8;
	}, end);
	await locator.page().waitForTimeout(100);
}

export async function keyboardUp(page, vp) {
	await page.setViewportSize({
		width: vp.width,
		height: vp.height - KEYBOARD_HEIGHT,
	});
	await settle(page);
}

export async function keyboardDown(page, vp) {
	await page.setViewportSize({ width: vp.width, height: vp.height });
	await settle(page);
}

// --- the run ----------------------------------------------------------------

/**
 * The jobs the filters leave: one per scene, viewport and theme.
 *
 * A filter is a substring of a suite, scene, viewport or theme name, or several
 * of them joined by commas to match any; with several filters, a scene runs
 * when every one of them matches. An `optIn` suite runs only when a filter
 * names it.
 */
export function plan(suites, argv) {
	const allThemes = argv.includes("--themes=all");
	const filters = argv.filter((a) => !a.startsWith("--"));
	const themes = (allThemes ? THEME_NAMES : ["abyss"]).flatMap((name) =>
		MODES.map((mode) => ({ name, mode, id: `${name}-${mode}` })),
	);
	const matches = (...names) =>
		filters.every((f) =>
			f.split(",").some((alt) => names.some((n) => n.includes(alt))),
		);
	const named = (suite) =>
		filters.some((f) => f.split(",").some((alt) => suite.name.includes(alt)));

	const jobs = [];
	for (const suite of suites) {
		if (suite.optIn && !named(suite)) continue;
		for (const vpName of suite.viewports)
			for (const theme of themes)
				for (const scene of suite.scenes) {
					const vp = { name: vpName, ...VIEWPORTS[vpName] };
					if (scene.touchOnly && !vp.touch) continue;
					if (scene.viewports && !scene.viewports.includes(vp.name)) continue;
					if (suite.themes && !suite.themes.includes(theme.id)) continue;
					if (!matches(suite.name, scene.name, vp.name, theme.id)) continue;
					jobs.push({ suite, vp, theme, scene });
				}
	}
	return jobs;
}

/**
 * Takes every suite's scenes through every viewport and theme the filters
 * leave (see `plan`), one fresh browser context per scene.
 */
export async function run(suites, argv) {
	const jobs = plan(suites, argv);
	if (jobs.length === 0) {
		console.error("No scene matches those filters.");
		process.exit(2);
	}

	const dirOf = (suite) => join(SHOTS_DIR, suite.dir);
	// Shots accumulate across runs, so a filtered run adds to a full one; a
	// failure is about one run only, and an old one would read as current. Only
	// this run's own scenes' are cleared: two suites may share a directory, and
	// one run after the other must not take the first one's failure with it.
	for (const { suite, scene, vp, theme } of jobs) {
		mkdirSync(dirOf(suite), { recursive: true });
		rmSync(
			join(dirOf(suite), `FAILED_${scene.name}_${vp.name}_${theme.id}.png`),
			{ force: true },
		);
	}

	const rpc = await Rpc.connect();
	const token = rpc.auth.session_token;

	// Every session the run needs is set up before the first screenshot, so the
	// desktop sidebar lists the same rows in every shot of a run.
	const shared = new Map();
	for (const suite of suites) {
		const own = jobs.filter((j) => j.suite === suite);
		if (own.length) shared.set(suite, await suite.setup({ rpc, jobs: own }));
	}

	const browser = await chromium.launch({
		args: [...new Set(suites.flatMap((s) => s.browserArgs ?? []))],
	});
	// A set: a retried scene takes its earlier shots again.
	const taken = new Set();
	const failed = [];

	// A scene that fails is tried once more, unless it had already done
	// something it cannot do twice (`sending`).
	async function runJob(job, retry = true) {
		const { suite, vp, theme, scene, session } = job;
		const where = `${scene.name}_${vp.name}_${theme.id}`;
		const context = await browser.newContext({
			viewport: { width: vp.width, height: vp.height },
			deviceScaleFactor: deviceScale(vp),
			isMobile: vp.touch,
			hasTouch: vp.touch,
			colorScheme: theme.mode,
			reducedMotion: "reduce",
			...suite.contextOptions,
		});
		await context.addInitScript(
			({ token, theme }) => {
				localStorage.setItem("auth_session_token", token);
				localStorage.setItem("theme-mode", theme.mode);
				localStorage.setItem("theme-name", theme.name);
			},
			{ token, theme },
		);
		const page = await context.newPage();
		// Generous: the machines this runs on are shared, and a step that
		// fails here costs the whole scene.
		page.setDefaultTimeout(30_000);
		// `tap` is the element the user presses next: its centre, in viewport
		// px, is saved beside the shot (<shot>.json), so a video built from the
		// shots taps where the element really is.
		// A state that taps nothing has no sidecar, not one left by an older run.
		const shot = async (state, { tap } = {}) => {
			const file = `${state}_${vp.name}_${theme.id}.png`;
			const sidecar = join(dirOf(suite), file.replace(/\.png$/, ".json"));
			rmSync(sidecar, { force: true });
			if (tap) {
				const box = await tap.boundingBox();
				const x = box && box.x + box.width / 2;
				const y = box && box.y + box.height / 2;
				// A box is also had for an element scrolled out of its container
				// or in a closed drawer: the centre has to be on the screen.
				if (!box || x < 0 || y < 0 || x > vp.width || y > vp.height)
					throw new Error(
						`${state}: the tap target is not on screen (${JSON.stringify(box)})`,
					);
				writeFileSync(sidecar, `${JSON.stringify({ tap: { x, y } })}\n`);
			}
			await page.screenshot({
				path: join(dirOf(suite), file),
				...suite.screenshotOptions,
			});
			taken.add(`${suite.dir}/${file}`);
			console.log(`${suite.dir}/${file}`);
		};
		let error;
		try {
			// Before the scene's first navigation, which is all a context's
			// routes and init scripts need; inside the try, so a failure here is
			// retried and reported like any other.
			await suite.prepare?.(context, scene);
			await scene.run({
				page,
				shared: shared.get(suite),
				session,
				shot,
				vp,
				sending: () => {
					retry = false;
				},
			});
		} catch (err) {
			error = err;
			if (!retry)
				await page
					.screenshot({ path: join(dirOf(suite), `FAILED_${where}.png`) })
					.catch(() => {});
		}
		await context.close();
		if (!error) return;
		const reason = error.message.split("\n")[0];
		if (retry) {
			console.error(`retrying ${suite.name}/${where}: ${reason}`);
			return runJob(job, false);
		}
		failed.push(`${suite.name}/${where}`);
		console.error(`FAILED ${suite.name}/${where}: ${reason}`);
	}

	// A `serial` suite's scenes depend on one another's order (one shoots a
	// state the next changes), so they run one at a time, as listed — a scene on
	// every viewport before the next scene on any — after the rest.
	const parallel = jobs.filter((j) => !j.suite.serial);
	const serial = jobs
		.filter((j) => j.suite.serial)
		.sort(
			(a, b) =>
				a.suite.scenes.indexOf(a.scene) - b.suite.scenes.indexOf(b.scene),
		);
	const workers = Number(process.env.WALKTHROUGH_WORKERS) || 4;
	let next = 0;
	try {
		await Promise.all(
			Array.from({ length: workers }, async () => {
				while (next < parallel.length) await runJob(parallel[next++]);
			}),
		);
		for (const job of serial) await runJob(job);
	} finally {
		await browser.close();
		rpc.close();
	}
	console.log(`\n${taken.size} screenshots in ${SHOTS_DIR}`);
	if (failed.length) {
		console.error(`${failed.length} scene(s) failed: ${failed.join(", ")}`);
		process.exit(1);
	}
}
