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

let pinned = 0;

/** Opens a disclosure, puts it at the top of the transcript, and shoots. */
async function expandAndShoot(page, shot, text, state) {
	// Pinned before the click: an open row's second line leaves its button
	// (docs/tool-call-ui.md#the-sticky-title-line), so a row found by that text
	// would not be found again once open.
	const id = `walk-${++pinned}`;
	await disclosure(page, text).evaluate(
		(el, id) => el.setAttribute("data-walk", id),
		id,
	);
	const target = page.locator(`[data-walk="${id}"]`);
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

/** The transcript, as the console of a run reads it: every open row's bar. */
async function logBars(page, label) {
	const bars = await page.evaluate(() => {
		const scroller = document.querySelector("[data-message-id]")?.closest(
			".overflow-y-auto",
		);
		const edge = scroller?.getBoundingClientRect().top ?? 0;
		return [...document.querySelectorAll(".row-bar")].map((bar) => ({
			text: bar.textContent?.slice(0, 40),
			top: Math.round(bar.getBoundingClientRect().top - edge),
			height: Math.round(bar.getBoundingClientRect().height),
			stuck: bar.hasAttribute("data-stuck"),
			shown: getComputedStyle(bar.firstElementChild).opacity,
		}));
	});
	console.log(label, JSON.stringify(bars));
}

/**
 * Scrolls so the open row a disclosure heads starts `by` pixels above the top
 * of the transcript. Measured on the row, not the button: a pinned button sits
 * at the top whatever the row under it is doing.
 */
async function scrollRowAbove(target, by) {
	await target.evaluate((button, by) => {
		const row = button.closest(".row-bar").parentElement;
		let scroller = row.parentElement;
		while (!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
			scroller = scroller.parentElement;
		scroller.scrollTop +=
			row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + by;
	}, by);
	await target.page().waitForTimeout(200);
}

/**
 * Folds an open row — by a tap, or by Enter with the row focused — and logs
 * where its top and its title sat against the top of the transcript before
 * and after, and whether focus stayed on it. `top` is the bar an outer row
 * would leave pinned over it, so a row folded from its pinned bar should land
 * there; one folded with its title on screen should leave the title at
 * `titleBefore`.
 */
async function foldAndLog(target, label, how = "tap") {
	const measure = () =>
		target.evaluate((button) => {
			const scroller = button.closest(".overflow-y-auto");
			const edge = scroller.getBoundingClientRect().top;
			const row = button.closest("[data-fold-probe]");
			const title = button.querySelector(".min-w-0 > span:first-child");
			return {
				row: Math.round(row.getBoundingClientRect().top - edge),
				title: Math.round(title.getBoundingClientRect().top - edge),
				focused: document.activeElement === button,
			};
		});
	await target.evaluate((button) => {
		button.closest(".row-bar").parentElement.dataset.foldProbe = "";
	});
	const before = await measure();
	if (how === "key") {
		await target.focus();
		await target.press("Enter");
	} else {
		await target.click();
	}
	await settle(target.page());
	const after = await measure();
	await target.evaluate((button) => {
		delete button.closest("[data-fold-probe]").dataset.foldProbe;
	});
	console.log(
		label,
		JSON.stringify({
			rowBefore: before.row,
			titleBefore: before.title,
			rowAfter: after.row,
			titleAfter: after.title,
			focused: after.focused,
		}),
	);
}

/**
 * Where a clamped block's edges and the line the reader sees at its bottom
 * sit against the top of the transcript, for the block `button` opens or
 * closes. The line is the one drawn just above whichever comes first, the
 * block's bottom or the view's.
 */
async function measureClamp(button) {
	return button.evaluate((el) => {
		const box = document.getElementById(el.getAttribute("aria-controls"));
		const scroller = box.closest(".overflow-y-auto");
		const view = scroller.getBoundingClientRect();
		const rect = box.getBoundingClientRect();
		const own = el.getBoundingClientRect();
		const y = Math.min(rect.bottom, view.bottom) - 6;
		const caret = document.caretRangeFromPoint(rect.left + 12, y);
		const text = caret?.startContainer.textContent ?? "";
		const at = caret?.startOffset ?? 0;
		const line = text.slice(
			text.lastIndexOf("\n", at - 1) + 1,
			(text.indexOf("\n", at) + 1 || text.length + 1) - 1,
		);
		return {
			top: Math.round(rect.top - view.top),
			bottom: Math.round(rect.bottom - view.top),
			button: Math.round(own.top - view.top),
			view: Math.round(view.height),
			fromEnd: Math.round(
				scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
			),
			line: line.trim().slice(0, 48),
		};
	});
}

/**
 * Logs the row's pinned title and the pinned section header under it, and
 * what is drawn at the title's middle — the title, or a header passing over
 * it — and whether a tap just above the header's collapse control is still
 * the control's.
 */
async function logPinnedHeader(page, label) {
	const state = await page.locator(".section-bar").evaluate((header) => {
		const scroller = header.closest(".overflow-y-auto");
		const top = scroller.getBoundingClientRect().top;
		const bar = header
			.closest(".row-bar ~ *")
			.parentElement.querySelector(":scope > .row-bar");
		const b = bar.getBoundingClientRect();
		const h = header.getBoundingClientRect();
		const atTitle = document.elementFromPoint(b.left + 40, b.bottom - 4);
		return {
			bar: [Math.round(b.top - top), Math.round(b.bottom - top)],
			header: [Math.round(h.top - top), Math.round(h.bottom - top)],
			headerStuck: header.hasAttribute("data-stuck"),
			pinnedBars: document.querySelectorAll("[data-stuck]").length,
			titleOnTop: bar.contains(atTitle),
			// A tap 8px above the collapse control, inside its hit area:
			// still the control's, not the row's bar under it.
			tapAboveCollapse: (() => {
				const c = header
					.querySelector("button[aria-controls]")
					.getBoundingClientRect();
				return header.contains(
					document.elementFromPoint(c.left + c.width / 2, c.top - 8),
				);
			})(),
		};
	});
	console.log(label, JSON.stringify(state));
}

/**
 * Presses a clamp's button and logs the block before and after. The button is
 * pinned first, since pressing it renames it. Place it in sight first: the
 * driver scrolls a button out of sight into view before tapping it, and the
 * "before" would then be somewhere the reader never was.
 */
async function toggleAndLog(locator, label, { unseen = false } = {}) {
	const id = `walk-${++pinned}`;
	await locator.evaluate((el, id) => el.setAttribute("data-walk", id), id);
	const button = locator.page().locator(`[data-walk="${id}"]`);
	const before = await measureClamp(button);
	// A button out of sight is pressed from script: a tap would have the
	// driver scroll it into view first, which is not the state being shot.
	if (unseen) await button.evaluate((el) => el.click());
	else await button.click();
	await settle(button.page());
	const after = await measureClamp(button);
	console.log(label, JSON.stringify({ before, after }));
}

/** Scrolls the transcript so the element's top is `y` pixels below its top. */
async function placeAt(locator, y) {
	await locator.evaluate((el, y) => {
		const scroller = el.closest(".overflow-y-auto");
		scroller.scrollTop +=
			el.getBoundingClientRect().top -
			scroller.getBoundingClientRect().top -
			y;
	}, y);
	await locator.page().waitForTimeout(200);
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
			const read = await expandAndShoot(
				page,
				shot,
				"handlers.ts",
				"expanded-read-long",
			);
			// Opened in place and put back: the button turns into Show less, and
			// Show less cuts the content to its budget again.
			const more = page.getByRole("button", { name: /^Show \d+ more lines/ });
			await more.click();
			await settle(page);
			const less = page
				.getByRole("button", { name: /^Show less/ })
				.filter({ hasText: "Show less" });
			await scrollIntoView(less, { end: true });
			await shot("expanded-read-open");
			await less.click();
			await settle(page);
			console.log(
				"read-show-less",
				JSON.stringify({
					clamped: await more.evaluate((el) =>
						document
							.getElementById(el.getAttribute("aria-controls"))
							.hasAttribute("data-clamped"),
					),
					expanded: await more.getAttribute("aria-expanded"),
				}),
			);
			await close(read);
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
		// An open row's title pinned over its own body, alone and nested
		// (docs/tool-call-ui.md#the-sticky-title-line). Each shot is logged with
		// where every open bar measured, since a bar covered by another is the
		// one thing a picture shows as nothing.
		name: "sticky",
		run: async ({ page, shared, shot }) => {
			await openLongTurn(page, shared);
			const failed = disclosure(page, "--reporter=verbose");
			await scrollIntoView(failed);
			await failed.click();
			await settle(page);
			await scrollRowAbove(failed, 30);
			await logBars(page, "sticky-row");
			await shot("sticky-row");
			await close(failed);

			// A control scrolled up into view from inside a long body lands below
			// the bar, not under it. `nearest` is how Safari and Firefox bring a
			// focused control in; Chrome's focus() centres it, which hides this.
			const reads = disclosure(page, "Read 2 files");
			await scrollIntoView(reads);
			await reads.click();
			await settle(page);
			const read = disclosure(page, "handlers.ts");
			await scrollIntoView(read);
			await read.click();
			await settle(page);
			await page
				.getByRole("button", { name: /^Show (all\b|\d+ (more|earlier) )/ })
				.first()
				.click();
			await settle(page);
			await scrollRowAbove(read, 1200);
			const landed = await read.evaluate((button) => {
				const bar = button.closest(".row-bar");
				const control = bar.parentElement.querySelector(
					".row-bar ~ * button",
				);
				control.scrollIntoView({ block: "nearest" });
				return {
					stuck: bar.hasAttribute("data-stuck"),
					gap: Math.round(
						control.getBoundingClientRect().top -
							bar.getBoundingClientRect().bottom,
					),
				};
			});
			console.log("sticky-focus", JSON.stringify(landed));
			await shot("sticky-focus");
			await close(read);
			await close(reads);

			const task = disclosure(page, "Survey retry tests");
			await scrollIntoView(task);
			await task.click();
			await settle(page);
			await disclosure(page, /^\s*Process/).click();
			await settle(page);
			const inner = disclosure(page, "slack/notifier");
			await scrollIntoView(inner);
			await inner.click();
			await settle(page);
			await scrollRowAbove(task, 120);
			await logBars(page, "sticky-outer");
			await shot("sticky-outer");
			await scrollRowAbove(inner, 20);
			await logBars(page, "sticky-nested");
			await shot("sticky-nested");
			// Keyboard focus reaching the subagent's button while the inner bar
			// is pinned (Shift+Tab from a pending card's, with nothing between)
			// moves nothing: that bar is raised over the inner one, not left
			// blank. A key press first, so the focus that follows is visible.
			await inner.focus();
			await page.keyboard.press("Shift");
			await task.focus();
			await settle(page);
			const raised = await task.evaluate((button) => ({
				focused: button.matches(":focus-visible"),
				innerStuck: !!document.querySelector(".row-bar ~ * [data-stuck]"),
				shown: getComputedStyle(button).opacity,
				zIndex: getComputedStyle(button.closest(".row-bar")).zIndex,
			}));
			console.log("sticky-nested-focus", JSON.stringify(raised));
			await shot("sticky-nested-focus");
			await inner.focus();
			// Something above the inner row growing inside the Process moves it
			// down without a scroll: it is no longer pinned, and says so.
			await inner.evaluate((button) => {
				const probe = document.createElement("div");
				probe.id = "stuck-probe";
				probe.style.height = "120px";
				const row = button.closest(".row-bar").parentElement;
				row.parentElement.insertBefore(probe, row);
			});
			await settle(page);
			await logBars(page, "sticky-nested-pushed");
			await inner.evaluate(() =>
				document.getElementById("stuck-probe")?.remove(),
			);
			await settle(page);
			await scrollRowAbove(inner, 20);
			// The inner row's end carrying its bar out: the outer title is back.
			const innerHeight = await inner.evaluate(
				(button) =>
					button.closest(".row-bar").parentElement.getBoundingClientRect()
						.height,
			);
			await scrollRowAbove(inner, innerHeight - 20);
			await logBars(page, "sticky-nested-leaving");
			await shot("sticky-nested-leaving");

			// A pending card's bar keeps the card's tint and frame.
			await openChat(page, shared.permissionMulti, (p) =>
				p.locator("[data-permission-request-id]").nth(1),
			);
			const card = page
				.locator("[data-permission-request-id]")
				.nth(1)
				.locator("button[aria-expanded]")
				.first();
			await scrollRowAbove(card, 60);
			await logBars(page, "sticky-pending");
			await shot("sticky-pending");
		},
	},
	{
		// Folding an open row leaves the reader on it: from its pinned bar the
		// row lands at the top (under an outer row's bar when nested), and from
		// its title on screen the title does not move.
		name: "sticky-fold",
		run: async ({ page, shared, shot }) => {
			await openLongTurn(page, shared);
			const failed = disclosure(page, "--reporter=verbose");
			await scrollIntoView(failed);
			await failed.click();
			await settle(page);
			await scrollRowAbove(failed, 300);
			await foldAndLog(failed, "fold-pinned");
			await shot("fold-pinned");

			await failed.click();
			await settle(page);
			await scrollRowAbove(failed, 400);
			await foldAndLog(failed, "fold-pinned-key", "key");

			await failed.click();
			await settle(page);
			await scrollRowAbove(failed, -150);
			await foldAndLog(failed, "fold-on-screen");
			await shot("fold-on-screen");

			// A row kept open while its group was closed goes back into the group
			// as it folds: the group's summary is what lands.
			const reads = disclosure(page, "Read 2 files");
			await scrollIntoView(reads);
			await reads.click();
			await settle(page);
			const read = disclosure(page, "handlers.ts");
			await read.click();
			await settle(page);
			await page
				.getByRole("button", { name: /^Show (all\b|\d+ (more|earlier) )/ })
				.first()
				.click();
			await settle(page);
			await reads.click();
			await settle(page);
			await scrollRowAbove(read, 600);
			await read.click();
			await settle(page);
			const group = await reads.evaluate((button) => ({
				summary: Math.round(
					button.getBoundingClientRect().top -
						button.closest(".overflow-y-auto").getBoundingClientRect().top,
				),
				readShown: [...document.querySelectorAll("button")].some(
					(b) => b.textContent.includes("handlers.ts") && b.checkVisibility(),
				),
			}));
			console.log("fold-into-group", JSON.stringify(group));
			await shot("fold-into-group");

			const task = disclosure(page, "Survey retry tests");
			await scrollIntoView(task);
			await task.click();
			await settle(page);
			await disclosure(page, /^\s*Process/).click();
			await settle(page);
			const inner = disclosure(page, "slack/notifier");
			await scrollIntoView(inner);
			await inner.click();
			await settle(page);
			await scrollRowAbove(inner, 200);
			await foldAndLog(inner, "fold-nested-pinned");
			await shot("fold-nested-pinned");

			await inner.click();
			await settle(page);
			await scrollRowAbove(inner, -150);
			await foldAndLog(inner, "fold-nested-on-screen");
			await shot("fold-nested-on-screen");
		},
	},
	{
		// Folding while following a turn that is still running: the view stays
		// at the end and goes on following it (docs/agent-chat.md, "Where the
		// View Sits"). Logged with whether the bar was pinned when folded, and
		// whether growth after the fold was followed.
		name: "sticky-tail",
		run: async ({ page, shared, shot }) => {
			await openChat(page, shared.running, "Running it 200 times");
			const read = disclosure(page, "dispatcher.test.ts");
			await read.click();
			await settle(page);
			await logBars(page, "tail-open");
			await shot("tail-open");
			const view = () =>
				transcript(page).evaluate((el) => {
					while (!/(auto|scroll)/.test(getComputedStyle(el).overflowY))
						el = el.parentElement;
					return {
						fromEnd: Math.round(
							el.scrollHeight - el.clientHeight - el.scrollTop,
						),
						scrollButton: !!document.querySelector(
							'button[aria-label^="Scroll to bottom"]',
						),
					};
				});
			console.log("tail-before-fold", JSON.stringify(await view()));
			await foldAndLog(read, "tail-fold");
			console.log("tail-after-fold", JSON.stringify(await view()));
			// Output arriving after the fold: a reader still following sees it.
			await transcript(page).evaluate((el) => {
				const probe = document.createElement("div");
				probe.id = "tail-probe";
				probe.style.height = "300px";
				el.parentElement.append(probe);
			});
			await settle(page);
			console.log("tail-after-growth", JSON.stringify(await view()));
			await shot("tail-fold");
			await transcript(page).evaluate(() =>
				document.getElementById("tail-probe")?.remove(),
			);
		},
	},
	{
		name: "keep-place",
		run: async ({ page, shared, shot }) => {
			await openChat(page, shared.fullRun, "All 59 tests pass.");
			// Pinned before the click, as in `expandAndShoot`.
			await disclosure(page, "set -euo pipefail").evaluate((el) =>
				el.setAttribute("data-walk", "full-run"),
			);
			const row = page.locator('[data-walk="full-run"]');
			await row.click();
			await settle(page);
			// The whole open row on one screen, its bar at the top.
			await row.evaluate((button) => {
				const r = button.closest(".row-bar").parentElement;
				const scroller = r.closest(".overflow-y-auto");
				scroller.scrollTop +=
					r.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
			});
			await settle(page);
			await shot("keep-open");
			const height = await row.evaluate((button) => {
				const r = button.closest(".row-bar").parentElement;
				return Math.round(r.getBoundingClientRect().height);
			});
			const earlier = page.getByRole("button", {
				name: /^Show \d+ earlier lines of output/,
			});
			const viewHeight = (await measureClamp(earlier)).view;
			console.log("keep-fits", JSON.stringify({ row: height, viewHeight }));

			// Opened with the output's tail in the middle of the screen: its
			// bottom, and the line there, stay put.
			await placeAt(earlier, 150);
			await toggleAndLog(earlier, "keep-earlier");
			await shot("keep-earlier");
			// Closed from its button: the button stays where it was pressed. The
			// pinned header's control has the same name and no text.
			const less = page
				.getByRole("button", { name: /^Show less of output/ })
				.filter({ hasText: "Show less" });
			await placeAt(less, 200);
			await toggleAndLog(less, "keep-less");

			// Closed with its button out of sight under the pinned title — a
			// screen reader can press it there: the section's header lands just
			// under that title.
			await placeAt(earlier, 150);
			await earlier.click();
			await settle(page);
			await placeAt(less, 10);
			await toggleAndLog(less, "keep-less-unseen", { unseen: true });
			await shot("keep-less-unseen");

			// Opened and read in its middle: the output's header pinned under
			// the row's title; at its end, carried off under that title; closed
			// from the header there, landed just under the title.
			await placeAt(earlier, 150);
			await earlier.click();
			await settle(page);
			await placeAt(less, -400);
			await logPinnedHeader(page, "keep-header-pinned");
			await shot("keep-header-pinned");
			await less.evaluate((el) => {
				const section = el.closest(".tool-section");
				const scroller = el.closest(".overflow-y-auto");
				scroller.scrollTop +=
					section.getBoundingClientRect().bottom -
					scroller.getBoundingClientRect().top -
					56;
			});
			await page.waitForTimeout(200);
			await logPinnedHeader(page, "keep-header-leaving");
			await shot("keep-header-leaving");
			await placeAt(less, -400);
			const collapse = page.locator(".section-bar button[aria-controls]");
			await collapse.click();
			await settle(page);
			console.log(
				"keep-header-closed",
				JSON.stringify(
					await earlier.evaluate((el) => {
						const header = el.closest(".tool-section").firstElementChild;
						const scroller = el.closest(".overflow-y-auto");
						return {
							header: Math.round(
								header.getBoundingClientRect().top -
									scroller.getBoundingClientRect().top,
							),
							pinned: header.classList.contains("section-bar"),
							focus: document.activeElement?.getAttribute("aria-label"),
						};
					}),
				),
			);
			await shot("keep-header-closed");

			// The command, cut at its end: opening keeps its top, closing its
			// button.
			const more = page.getByRole("button", {
				name: /^Show (\d+ more lines|all) of command/,
			});
			await placeAt(more, 400);
			await toggleAndLog(more, "keep-more-command");
			const lessCommand = page
				.getByRole("button", { name: /^Show less of command/ })
				.filter({ hasText: "Show less" });
			await placeAt(lessCommand, 450);
			await toggleAndLog(lessCommand, "keep-less-command");
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
		name: "message-actions",
		run: async ({ page, shared, shot }) => {
			const row = () =>
				page.getByRole("group", { name: "Message actions" }).last();
			await openChat(page, shared.attachments, "files changed");
			await scrollTranscript(page, "end");
			await shot("message-actions");
			await page
				.getByRole("button", { name: "Actions for your message" })
				.click();
			await settle(page);
			await shot("message-menu-user");

			// A settled reply cannot hold a pending permission (an open turn
			// keeps its reply streaming), so the blocked Fork a real chat can
			// reach is `no-anchor-seq`: history records the server never
			// addressed. Staged by taking the seqs off this chat's history.
			await page.routeWebSocket(/./, (ws) => {
				const server = ws.connectToServer();
				server.onMessage((message) => {
					const data = typeof message === "string" && JSON.parse(message);
					for (const record of data?.result?.history ?? []) delete record.seq;
					ws.send(data ? JSON.stringify(data) : message);
				});
			});
			await page.reload();
			await row().waitFor();
			await settle(page);
			await scrollTranscript(page, "end");
			await shot("message-actions-fork-blocked");
			// Forced: Playwright reads `aria-disabled` as not clickable, but a
			// blocked Fork is meant to be pressed — it opens the menu saying why.
			await row()
				.getByRole("button", { name: "Fork from here" })
				.click({ force: true });
			await settle(page);
			await shot("message-menu-fork-blocked");
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
		fullRun: await open("fullRun"),
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
