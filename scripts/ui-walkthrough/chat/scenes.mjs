// The chat UI — header and composer, attachments, the permission mode, tool
// rows and groups, subagents and their Process, the permission card and the
// strip's permission row, the turn's changes, tool bodies and Markdown, the
// thinking row and the tail line — on a real browser. A suite for
// ../shoot.mjs; see the README beside it.

import { crc32, deflateSync } from "node:zlib";
import {
	BASE_URL,
	keyboardDown,
	keyboardUp,
	scrollIntoView,
	settle,
} from "../harness.mjs";
import { CHAT } from "./scenarios.mjs";

// --- server side ------------------------------------------------------------

/** A w×h RGB PNG of horizontal bands, standing in for a phone screenshot. */
function png(w, h) {
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
	const rows = [];
	for (let y = 0; y < h; y++) {
		const row = Buffer.alloc(1 + w * 3);
		const band = Math.floor(y / (h / 8));
		for (let x = 0; x < w; x++)
			row.set(
				band === 2 && x < w * 0.8 ? [200, 40, 40] : [30 + band * 20, 34, 48],
				1 + x * 3,
			);
		rows.push(row);
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const CRASH_LOG = `2026-10-03T02:14:07.912Z worker[4127] TypeError: The "key" argument must be of type string. Received null
    at new Hmac (node:internal/crypto/hash:146:3)
    at createHmac (node:crypto:162:10)
    at signPayload (src/webhooks/signing.ts:4:9)
    at deliver (src/webhooks/sender/deliver.ts:25:27)
    at Dispatcher.flush (src/webhooks/dispatcher.ts:58:28)
`;

const ATTACHMENTS = [
	{ name: "worker-crash.png", type: "image/png", data: png(390, 844) },
	{ name: "worker-2026-10-03.log", type: "text/plain", data: CRASH_LOG },
];

// --- browser side -----------------------------------------------------------

/** A disclosure — tool row, group summary, Process, file row — by its text. */
const disclosure = (page, text) =>
	page.locator("button[aria-expanded]").filter({ hasText: text }).first();
const composer = (page) => page.locator("textarea").first();

/** Opens a chat and waits until `ready` (text or locator) is on the page. */
async function openChat(page, sessionId, ready) {
	await page.goto(`${BASE_URL}/s/${sessionId}`);
	const marker =
		typeof ready === "string" ? page.getByText(ready) : ready(page);
	await marker.first().waitFor();
	await settle(page);
}

// The transcript's own scroller, found from a message inside it.
function transcript(page) {
	return page.locator("[data-message-id]").first();
}

async function scrollTranscript(page, to) {
	return transcript(page).evaluate((el, to) => {
		while (!/(auto|scroll)/.test(getComputedStyle(el).overflowY))
			el = el.parentElement;
		if (to === "top") el.scrollTop = 0;
		else if (to === "end") el.scrollTop = el.scrollHeight;
		else el.scrollTop += to * el.clientHeight;
		return {
			top: el.scrollTop === 0,
			end: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
		};
	}, to);
}

/**
 * To the very top. History is paged (docs/agent-chat.md#history-paging): a
 * chat opens on its last records, and reaching the top loads the page before
 * and keeps the view where it was — so it takes as many trips as there are
 * pages, and the rows on them are not on the page until then.
 */
async function scrollToBeginning(page) {
	const beginning = page.getByText("Beginning of conversation");
	for (let i = 0; i < 20; i++) {
		const { top } = await scrollTranscript(page, "top");
		if (top && (await beginning.isVisible())) return settle(page);
		await page.waitForTimeout(300);
	}
	throw new Error("the beginning of the conversation never loaded");
}

/** The long turn, all of it loaded. */
async function openLongTurn(page, shared) {
	await openChat(page, shared.long, "files changed");
	await scrollToBeginning(page);
}

/**
 * The whole transcript, screen by screen from the top, as `<state>-01`,
 * `-02`, …: each step is four fifths of a screen, so a row cut at one shot's
 * edge is whole in the next.
 */
async function pageThrough(page, shot, state) {
	await scrollToBeginning(page);
	for (let i = 1; ; i++) {
		await page.waitForTimeout(150);
		await shot(`${state}-${String(i).padStart(2, "0")}`);
		if ((await scrollTranscript(page, 0)).end || i === 30) return;
		await scrollTranscript(page, 0.8);
	}
}

/** Opens a disclosure, puts it at the top of the transcript, and shoots. */
async function expandAndShoot(page, shot, text, state) {
	const target = disclosure(page, text);
	await scrollIntoView(target);
	await target.click();
	await settle(page);
	await scrollIntoView(target);
	await shot(state);
	return target;
}

async function close(target) {
	await target.click();
	await settle(target.page());
}

/** The composer focused with a draft, and the soft keyboard up. */
async function typeWithKeyboard(page, vp, draft) {
	await composer(page).click();
	if (draft) await page.keyboard.type(draft);
	await keyboardUp(page, vp);
}

// Each scene gets a fresh browser context and shared chats, played once in
// setup. A scene that names `fresh` gets a chat of its own per viewport and
// theme instead, titled that and still empty, and sends its prompt itself:
// what it shoots only exists while the page watches it happen.
const SCENES = [
	{
		name: "long-turn",
		run: async ({ page, shared, shot, vp }) => {
			await openChat(page, shared.long, "files changed");
			await pageThrough(page, shot, "long-turn");
			if (vp.touch) {
				await scrollTranscript(page, "end");
				await typeWithKeyboard(page, vp, "Also log every retry");
				await shot("long-turn-keyboard");
			}
		},
	},
	{
		name: "header",
		run: async ({ page, shared, shot }) => {
			await openChat(page, shared.long, "files changed");
			await page
				.locator("header button[aria-expanded]")
				.filter({ hasText: CHAT.long.title })
				.click();
			await settle(page);
			await shot("header-session-panel");
		},
	},
	{
		name: "expanded",
		run: async ({ page, shared, shot }) => {
			await openLongTurn(page, shared);
			for (const [text, state] of [
				["Thought for", "expanded-thinking"],
				["--reporter=verbose", "expanded-bash-failed"],
				["git log --oneline", "expanded-bash-long-command"],
				["dev:webhook-sink", "expanded-bash-background"],
			])
				await close(await expandAndShoot(page, shot, text, state));

			const reads = await expandAndShoot(
				page,
				shot,
				"Read 2 files",
				"expanded-group-reads",
			);
			await close(
				await expandAndShoot(page, shot, "handlers.ts", "expanded-read-long"),
			);
			await close(reads);

			const edits = await expandAndShoot(
				page,
				shot,
				"Edited 8 files",
				"expanded-group-edits",
			);
			await close(
				await expandAndShoot(page, shot, "dead-letter.ts", "expanded-edit"),
			);
			await close(
				await expandAndShoot(page, shot, "backoff.test.ts", "expanded-write"),
			);
			await close(edits);
			await close(
				await expandAndShoot(
					page,
					shot,
					"String to replace not found",
					"expanded-edit-failed",
				),
			);
		},
	},
	{
		name: "subagent",
		run: async ({ page, shared, shot }) => {
			await openLongTurn(page, shared);
			const task = await expandAndShoot(
				page,
				shot,
				"Survey retry tests",
				"subagent-open",
			);
			const process = await expandAndShoot(
				page,
				shot,
				/^\s*Process/,
				"subagent-process",
			);
			await scrollIntoView(process, { end: true });
			await shot("subagent-process-end");
			await close(
				await expandAndShoot(
					page,
					shot,
					"slack/notifier",
					"subagent-step-failed",
				),
			);
			await close(task);
		},
	},
	{
		name: "changes",
		run: async ({ page, shared, shot }) => {
			await openLongTurn(page, shared);
			const card = page.getByText("8 files changed");
			await scrollIntoView(card);
			await shot("changes-card");
			await page.getByRole("button", { name: /Show \d+ more files/ }).click();
			await settle(page);
			await scrollIntoView(card);
			await shot("changes-card-all");
			await expandAndShoot(
				page,
				shot,
				"deliver.ts in src/webhooks/sender",
				"changes-file-open",
			);
		},
	},
	{
		name: "markdown",
		run: async ({ page, shared, shot }) => {
			await openLongTurn(page, shared);
			await scrollIntoView(page.getByRole("heading", { name: "What changed" }));
			await shot("markdown-table");
			await scrollIntoView(page.getByRole("heading", { name: "The curve" }));
			await shot("markdown-code");
		},
	},
	{
		name: "attachments",
		run: async ({ page, shared, shot, vp }) => {
			await openChat(page, shared.attachments, "files changed");
			await scrollTranscript(page, "top");
			await shot("attachments-sent");
			await scrollTranscript(page, "end");
			await page.getByRole("button", { name: "Add", exact: true }).click();
			await settle(page);
			await shot("composer-menu");
			await page.keyboard.press("Escape");
			await page.getByTestId("file-input").setInputFiles(
				ATTACHMENTS.map(({ name, type, data }) => ({
					name,
					mimeType: type,
					buffer: Buffer.from(data),
				})),
			);
			await page.getByText(ATTACHMENTS[1].name).last().waitFor();
			await composer(page).fill("Same crash again this morning.");
			await settle(page);
			await shot("composer-attachments");
			if (vp.touch) {
				await typeWithKeyboard(page, vp);
				await shot("composer-attachments-keyboard");
			}
		},
	},
	{
		name: "permission",
		run: async ({ page, shared, shot, vp }) => {
			await openChat(page, shared.permission, (p) =>
				p.locator("[data-permission-request-id]"),
			);
			await scrollTranscript(page, "end");
			await shot("permission-card");
			await scrollTranscript(page, "top");
			await shot("permission-strip");
			if (vp.touch) {
				await scrollTranscript(page, "end");
				await typeWithKeyboard(page, vp);
				await shot("permission-keyboard");
			}
		},
	},
	{
		name: "permission-multi",
		run: async ({ page, shared, shot }) => {
			await openChat(page, shared.permissionMulti, (p) =>
				p.locator("[data-permission-request-id]").nth(1),
			);
			await scrollIntoView(
				page.locator("[data-permission-request-id]").first(),
			);
			await shot("permission-multi-edit");
			await scrollTranscript(page, "end");
			await shot("permission-multi-write");
		},
	},
	{
		name: "asking",
		run: async ({ page, shared, shot, vp }) => {
			await openChat(page, shared.asking, (p) => p.getByRole("dialog"));
			await shot("asking-panel");
			await page
				.getByRole("dialog")
				.getByRole("button", { name: "Close" })
				.click();
			await settle(page);
			await shot("asking-strip");
			if (vp.touch) {
				await typeWithKeyboard(page, vp, "Before that:");
				await shot("asking-keyboard");
			}
		},
	},
	{
		name: "running",
		run: async ({ page, shared, shot }) => {
			await openChat(page, shared.running, "Working");
			// The tail line's clock, which is not drawn under 3s: in a run
			// filtered down to this scene the turn may be younger than that.
			await page
				.getByText(/^(\d+m )?\d+s$/)
				.first()
				.waitFor();
			await scrollTranscript(page, "end");
			await shot("running");
			await expandAndShoot(page, shot, "seq 1 200", "running-bash-open");
		},
	},
	{
		name: "parked",
		run: async ({ page, shared, shot }) => {
			await openChat(page, shared.parked, CHAT.parked.waiting);
			await scrollTranscript(page, "end");
			// Blocked on background work, the reply is not finished: its
			// turn-end slot keeps its height and offers no Copy or Fork.
			await shot("parked");
		},
	},
	{
		name: "thinking",
		fresh: CHAT.thinking.title,
		run: async ({ page, session, shot, vp, sending }) => {
			await page.goto(`${BASE_URL}/s/${session}`);
			await composer(page).waitFor();
			await settle(page);
			await composer(page).fill(CHAT.thinking.prompt);
			if (vp.touch) {
				await keyboardUp(page, vp);
				await shot("thinking-draft-keyboard");
				await keyboardDown(page, vp);
			}
			sending();
			await page.getByRole("button", { name: "Send" }).click();
			await page.getByText(CHAT.thinking.reading).first().waitFor();
			await settle(page);
			await shot("streaming");
			await page.getByText("Thinking…").first().waitFor();
			// Past the 3s under which the tail line shows no clock.
			await page.waitForTimeout(3500);
			await shot("thinking-live");
			// Ends the turn, so the scenes after this one do not find a sidebar
			// full of chats still spinning.
			await page.getByRole("button", { name: "Stop" }).click();
		},
	},
	{
		name: "tool-running",
		fresh: CHAT.toolRunning.title,
		run: async ({ page, session, shot, sending }) => {
			await page.goto(`${BASE_URL}/s/${session}`);
			await composer(page).waitFor();
			await settle(page);
			await composer(page).fill(CHAT.toolRunning.prompt);
			sending();
			await page.getByRole("button", { name: "Send" }).click();
			const group = disclosure(page, "3 steps");
			await group.waitFor();
			// The clock on the current step, which is not drawn under 3s.
			await group.getByText(/^(\d+m )?\d+s$/).waitFor();
			await settle(page);
			// Every shot is taken under reduced motion (harness.mjs), where a
			// running row's glyph is a still dot; this one shows the spinner.
			await shot("tool-running-group");
			await page.emulateMedia({ reducedMotion: "no-preference" });
			await shot("tool-running-group-motion");
			await page.emulateMedia({ reducedMotion: "reduce" });
			await group.click();
			await settle(page);
			await scrollTranscript(page, "end");
			await shot("tool-running-row");
			// Ends the turn, as `thinking` does.
			await page.getByRole("button", { name: "Stop" }).click();
		},
	},
];

/** Every chat the scenes share, each played once. */
async function setup({ rpc, jobs }) {
	const open = (key, options) =>
		rpc.session(CHAT[key].title, CHAT[key].prompt, options);
	const shared = {
		// YOLO, so the header's permission mode has its glyph in these shots;
		// every other chat is in Default.
		long: await open("long", { mode: "yolo" }),
		attachments: await open("attachments", { files: ATTACHMENTS }),
		permission: await open("permission"),
		permissionMulti: await open("permissionMulti"),
		asking: await open("asking"),
		running: await open("running"),
		parked: await open("parked"),
	};
	for (const job of jobs) {
		if (job.scene.fresh) job.session = await rpc.emptySession(job.scene.fresh);
	}
	return shared;
}

export default {
	name: "chat",
	dir: "chat-ui",
	viewports: ["375x667", "375x560", "360x740", "1440x900"],
	scenes: SCENES,
	setup,
};
