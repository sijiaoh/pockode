// The answering UI (docs/answering-ui.md) in every state that document
// describes. A suite for ../shoot.mjs; see the README beside it.

import {
	BASE_URL,
	keyboardDown,
	keyboardUp,
	mcp,
	scrollIntoView,
	settle,
} from "../harness.mjs";
import { Q, SCENARIOS } from "./scenarios.mjs";

// --- server side ------------------------------------------------------------

/** A new chat whose agent has just asked `scenario`. */
function askedSession(rpc, scenario, title) {
	return rpc.session(title, SCENARIOS[scenario].prompt);
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

async function scrollBodyToEnd(page) {
	await dialog(page)
		.locator(".overflow-y-auto")
		.first()
		.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
	await page.waitForTimeout(100);
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
			await keyboardDown(page, vp);
			await page.getByPlaceholder("Type a message...").click();
			await keyboardUp(page, vp);
			await shot("keyboard-in-composer");
			// The keyboard going down with the caret still in the composer: a card
			// that stepped aside comes back as it left.
			await keyboardDown(page, vp);
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

export default {
	name: "question",
	dir: "question-ui",
	viewports: ["375x667", "390x844", "375x560", "1440x900"],
	scenes: SCENES,
	async setup({ rpc, jobs }) {
		const shared = {
			batch: await askedSession(rpc, "batch", "Job queue setup"),
			single: await askedSession(rpc, "single", "Job queue database"),
			story: await askedStory(),
		};
		for (const job of jobs) {
			if (job.scene.fresh)
				job.session = await askedSession(rpc, "batch", job.scene.fresh);
		}
		return shared;
	},
};
