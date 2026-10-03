// Drives the answering UI through every state the walkthrough covers and saves
// one screenshot per state, viewport and theme as <state>_<viewport>_<theme>.png.
// Run through run.sh, which provides the environment this reads.
//
//   node shoot.mjs [--themes=all] [filter...]
//
// A filter is a substring of a scene, viewport or theme name, or several of
// them joined by commas to match any; with several filters, a scene runs when
// every one of them matches.

import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Q, SCENARIOS } from "./scenarios.mjs";

const require = createRequire(join(process.env.WALKTHROUGH_NODE_MODULES, "_"));
const { chromium } = require("playwright-core");

const BASE_URL = process.env.WALKTHROUGH_URL;
const PASSWORD = process.env.WALKTHROUGH_PASSWORD;
const DATA_DIR = process.env.WALKTHROUGH_DATA_DIR;
const SHOTS_DIR = process.env.SHOTS_DIR;

// Height a phone's soft keyboard takes. The app's viewport meta says
// interactive-widget=resizes-content, so a keyboard shrinks the layout
// viewport exactly as a smaller window does — which is how it is simulated.
const KEYBOARD_HEIGHT = 300;

const VIEWPORTS = [
	{ name: "375x667", width: 375, height: 667, touch: true },
	{ name: "390x844", width: 390, height: 844, touch: true },
	{ name: "375x560", width: 375, height: 560, touch: true },
	{ name: "1440x900", width: 1440, height: 900, touch: false },
];

const THEME_NAMES = ["abyss", "aurora", "ember", "mint", "void"];
const MODES = ["light", "dark"];

const argv = process.argv.slice(2);
const allThemes = argv.includes("--themes=all");
const filters = argv.filter((a) => !a.startsWith("--"));
const THEMES = (allThemes ? THEME_NAMES : ["abyss"]).flatMap((name) =>
	MODES.map((mode) => ({ name, mode, id: `${name}-${mode}` })),
);

// --- server side ------------------------------------------------------------

class Rpc {
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

	close() {
		this.ws.close();
	}
}

async function mcp(name, args) {
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

/** A new chat whose agent has just asked `scenario`. */
async function askedSession(rpc, scenario, title) {
	const session = await rpc.call("session.create", {});
	await rpc.call("session.update_title", { session_id: session.id, title });
	await rpc.call("chat.message", {
		session_id: session.id,
		content: SCENARIOS[scenario].prompt,
	});
	return session.id;
}

/** A started story whose agent asked the "work" scenario on kickoff. */
async function askedStory() {
	const [role] = JSON.parse(await mcp("agent_role_list", {}));
	const created = await mcp("story_create", {
		title: "Add retry with backoff to the webhook sender",
		body: "Failed webhook deliveries are dropped today. Retry them with exponential backoff, up to an hour.",
		agent_role_id: role.id,
	});
	const id = created.match(/\(ID: ([^)]+)\)/)[1];
	await mcp("story_start", { id });
	return id;
}

// --- browser side -----------------------------------------------------------

const dialog = (page) => page.getByRole("dialog");
const block = (page, q) =>
	dialog(page)
		.locator("[data-answer-block]")
		.filter({ has: page.getByText(q.header, { exact: true }) });
const option = (page, q, label) =>
	block(page, q).locator("label").filter({ hasText: label }).first();
const otherInput = (page, q) =>
	block(page, q).getByRole("textbox", { name: `Other answer for ${q.header}` });
async function pickOtherControl(page, q) {
	// The Other control is the input whose <label for> reads "Other".
	const id = await block(page, q)
		.locator("label", { hasText: /^Other$/ })
		.getAttribute("for");
	await page.locator(`[id="${id}"]`).click();
}

async function openSession(page, sessionId, questions = 5) {
	await page.goto(`${BASE_URL}/s/${sessionId}`);
	await dialog(page)
		.locator("[data-answer-block]")
		.nth(questions - 1)
		.waitFor();
	await settle(page);
}

async function settle(page) {
	// Fonts and the last layout pass; nothing here animates on purpose.
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(250);
}

// Scrolls the scroller nearest to the element so the element is at its top
// (or, with `end`, its bottom at the bottom) — and nothing else.
// Element.scrollIntoView would also scroll every ancestor, the answer card's
// `overflow-hidden` frame included, which shifts the card's header out of
// view: a state of the driver's making, not the user's.
async function scrollIntoView(locator, { end = false } = {}) {
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

async function scrollBodyToEnd(page) {
	await dialog(page)
		.locator(".overflow-y-auto")
		.first()
		.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
	await page.waitForTimeout(100);
}

async function keyboardUp(page, vp) {
	await page.setViewportSize({
		width: vp.width,
		height: vp.height - KEYBOARD_HEIGHT,
	});
	await settle(page);
}

async function answerAll(page) {
	await option(page, Q.database, "Postgres").click();
	await block(page, Q.database)
		.getByRole("button", { name: /Add a note/ })
		.click();
	await page.keyboard.type("Pin it to 16.");
	await option(page, Q.runtimes, "Node 24").click();
	await pickOtherControl(page, Q.runtimes);
	await otherInput(page, Q.runtimes).fill("Deno 2");
	await block(page, Q.releaseNote)
		.getByRole("textbox", { name: Q.releaseNote.header })
		.fill("Self-hosted users: run `pockode migrate jobs` before upgrading.");
	await block(page, Q.migration).getByLabel("Won't answer").check();
	await block(page, Q.migration)
		.getByPlaceholder("Add a note (optional)")
		.fill("Let's decide this on Monday's call.");
	await option(page, Q.region, "eu-west-1").click();
}

// Each scene gets a fresh browser context, so no draft leaks between them, and
// calls `shot` once per screenshot with the state it is filed under. A scene
// that sends answers names `fresh`: it gets a session of its own per viewport
// and theme, asked the batch and titled that, and calls `sending` just before
// it sends, after which it can no longer be retried.
const SCENES = [
	{
		name: "panel-open",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await shot("panel-open");
			await scrollBodyToEnd(page);
			await shot("panel-open-end");
		},
	},
	{
		name: "panel-single",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.single, 1);
			await shot("panel-single");
		},
	},
	{
		name: "long-wrap",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await scrollIntoView(block(page, Q.migration));
			await shot("long-wrap");
			await option(page, Q.migration, "Dual-write").click();
			await shot("long-wrap-selected");
		},
	},
	{
		name: "single",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await option(page, Q.database, "SQLite").click();
			await scrollIntoView(block(page, Q.database));
			await shot("single-selected");
		},
	},
	{
		name: "multi",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await option(page, Q.runtimes, "Node 22").click();
			await option(page, Q.runtimes, "Bun").click();
			await scrollIntoView(block(page, Q.runtimes));
			await shot("multi-selected");
			await pickOtherControl(page, Q.runtimes);
			await shot("multi-other-empty");
		},
	},
	{
		name: "free-text",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			const box = block(page, Q.releaseNote).getByRole("textbox", {
				name: Q.releaseNote.header,
			});
			await scrollIntoView(block(page, Q.releaseNote));
			await shot("free-text-empty");
			await box.fill(
				"Self-hosted users must run `pockode migrate jobs` before upgrading.\nThe migration is idempotent and takes under a minute for a million rows.",
			);
			await shot("free-text-typed");
		},
	},
	{
		name: "other",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await scrollIntoView(block(page, Q.database));
			await shot("other-idle");
			await otherInput(page, Q.database).click();
			await shot("other-clicked");
			await page.keyboard.type("MySQL — we already have a licence");
			await shot("other-typed");
			await otherInput(page, Q.database).fill(
				"MySQL — we already have a licence\nbut only for the EU cluster\nso staging needs Postgres anyway\nand CI can use SQLite\nfive lines now\nsix lines scrolls",
			);
			await shot("other-multiline");
			await option(page, Q.database, "Postgres").click();
			await shot("other-text-unpicked");
		},
	},
	{
		name: "note",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await option(page, Q.database, "Postgres").click();
			await scrollIntoView(block(page, Q.database));
			await shot("note-offered");
			await block(page, Q.database)
				.getByRole("button", { name: /Add a note/ })
				.click();
			await page.keyboard.type("Pin it to 16, the extensions need it.");
			await shot("note-open");
			await pickOtherControl(page, Q.database);
			await shot("note-parked-other");

			await option(page, Q.runtimes, "Node 24").click();
			await block(page, Q.runtimes)
				.getByRole("button", { name: /Add a note/ })
				.click();
			await page.keyboard.type("Drop Node 22 next quarter.");
			await option(page, Q.runtimes, "Node 24").click();
			await scrollIntoView(block(page, Q.runtimes).getByText("Won't answer"), {
				end: true,
			});
			await shot("note-parked-none");
		},
	},
	{
		name: "decline",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await option(page, Q.region, "us-east-1").click();
			await block(page, Q.region).getByLabel("Won't answer").check();
			await block(page, Q.region)
				.getByPlaceholder("Add a note (optional)")
				.fill("Already said it in the ticket.");
			await scrollIntoView(block(page, Q.region));
			await shot("decline");
		},
	},
	{
		name: "ready",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await answerAll(page);
			await shot("ready-all");
		},
	},
	{
		name: "keyboard",
		touchOnly: true,
		run: async ({ page, shared, shot, vp }) => {
			await openSession(page, shared.batch);
			await otherInput(page, Q.database).click();
			await page.keyboard.type("MySQL");
			await keyboardUp(page, vp);
			await shot("keyboard-in-panel");
			await page.setViewportSize({ width: vp.width, height: vp.height });
			await page.getByPlaceholder("Type a message...").click();
			await keyboardUp(page, vp);
			await shot("keyboard-in-composer");
			// The keyboard going down with the caret still in the composer: a card
			// that stepped aside comes back as it left.
			await page.setViewportSize({ width: vp.width, height: vp.height });
			await settle(page);
			await shot("keyboard-composer-down");
			// And the strip's Answer taking the caret back into it — only where
			// the card stepped aside: at 390x844 the keyboard leaves 544px, above
			// the short-viewport threshold, so there is no row to press.
			await keyboardUp(page, vp);
			const answer = page.getByRole("button", { name: "Answer", exact: true });
			if (await answer.isVisible()) {
				await answer.click();
				await settle(page);
				await shot("keyboard-composer-answer");
			}
		},
	},
	{
		name: "closed",
		run: async ({ page, shared, shot }) => {
			await openSession(page, shared.batch);
			await dialog(page).getByRole("button", { name: "Close" }).click();
			await settle(page);
			await shot("closed-strip");
			await page
				.locator("button[aria-expanded]")
				.filter({ hasText: Q.database.header })
				.first()
				.click();
			await settle(page);
			await shot("record-pending-expanded");
		},
	},
	{
		name: "sent-partial",
		fresh: "Job queue (partly answered)",
		run: async ({ page, session, shot, sending }) => {
			await openSession(page, session);
			await option(page, Q.database, "Postgres").click();
			await option(page, Q.region, "eu-west-1").click();
			sending();
			await dialog(page).getByRole("button", { name: "Send" }).click();
			await dialog(page).getByText("2 answers sent.").waitFor();
			await settle(page);
			// As the user is left: the body where the last press scrolled it, and
			// the receipt in the footer, which is on screen either way.
			await shot("sent-partial");
			await dialog(page)
				.locator(".overflow-y-auto")
				.first()
				.evaluate((el) => {
					el.scrollTop = 0;
				});
			await page.waitForTimeout(100);
			await shot("sent-partial-top");
		},
	},
	{
		name: "sent-all",
		fresh: "Job queue (answered)",
		run: async ({ page, session, shot, sending }) => {
			await openSession(page, session);
			await answerAll(page);
			sending();
			await dialog(page).getByRole("button", { name: "Send" }).click();
			await dialog(page).waitFor({ state: "detached" });
			await page.getByText("Thanks — going with that.").waitFor();
			await settle(page);
			await shot("sent-transcript");

			const cards = page
				.locator("button[aria-expanded]")
				.filter({ hasText: "Question" });
			for (const q of [
				Q.database,
				Q.runtimes,
				Q.releaseNote,
				Q.migration,
				Q.region,
			]) {
				await cards.filter({ hasText: q.header }).first().click();
			}
			await settle(page);
			const first = cards.filter({ hasText: Q.database.header }).first();
			await scrollIntoView(first);
			await shot("record-cards-expanded");
			await scrollIntoView(
				cards.filter({ hasText: Q.migration.header }).first(),
			);
			await shot("record-cards-expanded-2");
		},
	},
	{
		name: "work",
		run: async ({ page, shared, shot }) => {
			await page.goto(`${BASE_URL}/works/${shared.story}`);
			await page.getByText(Q.workScope.question).first().waitFor();
			await settle(page);
			await shot("work-detail");
		},
	},
];

function matches(...names) {
	return filters.every((f) =>
		f.split(",").some((alt) => names.some((n) => n.includes(alt))),
	);
}

async function main() {
	mkdirSync(SHOTS_DIR, { recursive: true });
	// Shots accumulate across runs, so a filtered run adds to a full one; a
	// failure is about one run only, and an old one would read as current.
	for (const file of readdirSync(SHOTS_DIR))
		if (file.startsWith("FAILED_")) rmSync(join(SHOTS_DIR, file));
	const rpc = await Rpc.connect();
	const token = rpc.auth.session_token;

	const jobs = [];
	for (const vp of VIEWPORTS)
		for (const theme of THEMES)
			for (const scene of SCENES) {
				if (scene.touchOnly && !vp.touch) continue;
				if (!matches(scene.name, vp.name, theme.id)) continue;
				jobs.push({ vp, theme, scene });
			}

	// Every session the run needs is asked for before the first screenshot, so
	// the desktop sidebar lists the same rows in every shot of a run.
	const shared = {
		batch: await askedSession(rpc, "batch", "Job queue setup"),
		single: await askedSession(rpc, "single", "Job queue database"),
		story: await askedStory(),
	};
	for (const job of jobs) {
		if (job.scene.fresh)
			job.session = await askedSession(rpc, "batch", job.scene.fresh);
	}

	const browser = await chromium.launch();
	// A set: a retried scene takes its earlier shots again.
	const taken = new Set();
	const failed = [];

	// A scene that fails is tried once more, unless it had already sent
	// answers: that used its session up.
	async function runJob(job, retry = true) {
		const { vp, theme, scene, session } = job;
		const where = `${scene.name}_${vp.name}_${theme.id}`;
		const context = await browser.newContext({
			viewport: { width: vp.width, height: vp.height },
			deviceScaleFactor: vp.touch ? 2 : 1,
			isMobile: vp.touch,
			hasTouch: vp.touch,
			colorScheme: theme.mode,
			reducedMotion: "reduce",
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
		const shot = async (state) => {
			const file = `${state}_${vp.name}_${theme.id}.png`;
			await page.screenshot({ path: join(SHOTS_DIR, file) });
			taken.add(file);
			console.log(file);
		};
		let error;
		try {
			await scene.run({
				page,
				shared,
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
					.screenshot({ path: join(SHOTS_DIR, `FAILED_${where}.png`) })
					.catch(() => {});
		}
		await context.close();
		if (!error) return;
		const reason = error.message.split("\n")[0];
		if (retry) {
			console.error(`retrying ${where}: ${reason}`);
			return runJob(job, false);
		}
		failed.push(where);
		console.error(`FAILED ${where}: ${reason}`);
	}

	const workers = Number(process.env.WALKTHROUGH_WORKERS) || 4;
	let next = 0;
	try {
		await Promise.all(
			Array.from({ length: workers }, async () => {
				while (next < jobs.length) await runJob(jobs[next++]);
			}),
		);
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

await main();
