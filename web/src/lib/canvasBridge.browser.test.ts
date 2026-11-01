import { MEDIA_QUERIES } from "@pockode/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
	type CanvasAppMessage,
	type CanvasPageMessage,
	type CanvasTheme,
	canvasBaseCss,
	canvasBaseStylesheet,
	canvasBridgeScript,
	readCanvasPageMessage,
} from "./canvasBridge";

// Real engines, because what the bridge relies on is theirs: implicit
// submission on Enter and the submitter it names, what `FormData` holds,
// fragment parsing in a region's context and whether a script inserted by it
// runs. The test document is both sides: the bridge runs in it with the
// test's own window as the app, so what it posts arrives here and what is
// posted here is from "the app". The app's stylesheet is loaded here too and
// sets a `color-scheme` of its own, so the scheme is read from the base
// stylesheet's text rather than computed.

const LIGHT: CanvasTheme = {
	scheme: "light",
	vars: { "--pk-bg": "rgb(255, 255, 255)", "--pk-text": "rgb(0, 0, 0)" },
};

/**
 * The test's window as the page sees it: what the bridge defines, and where a
 * page's scripts note that they ran. A cast, not a global declaration, which
 * would type the app's own window as having them too.
 */
const probe = window as unknown as {
	pockode: { send(action: unknown, data?: unknown): Promise<void> };
	ran: string[];
};

let received: CanvasPageMessage[] = [];
let page: HTMLElement;

function onMessage(event: MessageEvent) {
	if (event.source !== window) return;
	const message = readCanvasPageMessage(event.data);
	if (message) received.push(message);
}

beforeAll(() => {
	document.head.insertAdjacentHTML("beforeend", canvasBaseStylesheet(LIGHT));
	const script = document.createElement("script");
	script.textContent = canvasBridgeScript("window").replace(
		/^<script>|<\/script>$/g,
		"",
	);
	document.head.append(script);
	window.addEventListener("message", onMessage);
	page = document.createElement("div");
	document.body.append(page);
});

afterEach(() => {
	page.innerHTML = "";
	received = [];
	probe.ran = [];
});

function draw(html: string) {
	page.innerHTML = html;
}

function toPage(message: CanvasAppMessage) {
	window.postMessage(message, "*");
}

function sends() {
	return received.filter((m) => m.type === "pockode:canvas-send");
}

async function nextSend() {
	await vi.waitFor(() => expect(sends()).toHaveLength(1));
	const [send] = sends();
	received = received.filter((m) => m !== send);
	if (send.type !== "pockode:canvas-send") throw new Error("not a send");
	return send;
}

/** Waits long enough for a send that should not happen to have arrived. */
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

function el<T extends Element>(selector: string): T {
	const found = document.querySelector<T>(selector);
	if (!found) throw new Error(`no ${selector}`);
	return found;
}

describe("pockode.send", () => {
	it("resolves once the app accepts, with data as JSON round-trips it", async () => {
		const sent = probe.pockode.send("save", {
			at: new Date(Date.UTC(2026, 0, 2)),
			gone: undefined,
			n: 1,
		});
		const send = await nextSend();
		expect(send.action).toBe("save");
		expect(send.data).toEqual({ at: "2026-01-02T00:00:00.000Z", n: 1 });
		toPage({ type: "pockode:canvas-send-result", id: send.id, ok: true });
		await expect(sent).resolves.toBeUndefined();
	});

	it("sends {} when data is omitted", async () => {
		probe.pockode.send("go").catch(() => {});
		expect((await nextSend()).data).toEqual({});
	});

	it("rejects with the app's code and message", async () => {
		const sent = probe.pockode.send("save", null);
		const send = await nextSend();
		toPage({
			type: "pockode:canvas-send-result",
			id: send.id,
			ok: false,
			code: "permission",
			message: "Answer the permission request first.",
		});
		await expect(sent).rejects.toMatchObject({
			code: "permission",
			message: "Answer the permission request first.",
		});
	});

	it("rejects what JSON cannot hold, and an empty action, without sending", async () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		await expect(probe.pockode.send("a", { n: 1n })).rejects.toMatchObject({
			code: "invalid",
		});
		await expect(probe.pockode.send("a", cycle)).rejects.toMatchObject({
			code: "invalid",
		});
		await expect(probe.pockode.send("", {})).rejects.toMatchObject({
			code: "invalid",
		});
		await expect(probe.pockode.send(7, {})).rejects.toMatchObject({
			code: "invalid",
		});
		await settle();
		expect(sends()).toEqual([]);
	});
});

describe("data-pk-send", () => {
	it("sends a button's action with its name and value", async () => {
		draw(
			'<button data-pk-send="approve" name="id" value="7"><b>OK</b></button>',
		);
		await userEvent.click(el("b"));
		const send = await nextSend();
		expect(send).toMatchObject({ action: "approve", data: { id: "7" } });
	});

	it("leaves a field inside a sending card to be operated, sending nothing", async () => {
		draw(`<div data-pk-send="open"><p>Card</p>
			<label><input type="checkbox" name="done"> Done</label></div>`);
		const box = el<HTMLInputElement>("input");
		await userEvent.click(box);
		await userEvent.click(el("label"));
		await userEvent.click(box);
		expect(box.checked).toBe(true);
		await settle();
		expect(sends()).toEqual([]);
		await userEvent.click(el("p"));
		expect((await nextSend()).action).toBe("open");
	});

	it("lets the nearest action win: a button's own over its form's", async () => {
		draw(`<form data-pk-send="create">
			<input name="title" value="Fix login">
			<button data-pk-send="draft">Draft</button>
		</form>`);
		await userEvent.click(el("button"));
		expect(await nextSend()).toMatchObject({
			action: "draft",
			data: { title: "Fix login" },
		});
		await settle();
		expect(sends()).toEqual([]);
	});

	it("submits a form with its fields and the submitter's name and value", async () => {
		draw(`<form data-pk-send="create">
			<input name="title" value="Fix login">
			<input type="checkbox" name="tag" value="a" checked>
			<input type="checkbox" name="tag" value="b" checked>
			<input type="checkbox" name="off" value="x">
			<input type="file" name="upload">
			<button name="as" value="urgent">Create</button>
		</form>`);
		await userEvent.click(el("button"));
		const send = await nextSend();
		expect(send.action).toBe("create");
		expect(send.data).toEqual({
			title: "Fix login",
			tag: ["a", "b"],
			as: "urgent",
		});
	});

	it("submits a form by Enter in one of its fields", async () => {
		draw(`<form data-pk-send="create">
			<input name="title"><button>Create</button>
		</form>`);
		await userEvent.type(el("input"), "Fix{Enter}");
		expect(await nextSend()).toMatchObject({
			action: "create",
			data: { title: "Fix" },
		});
	});

	it("sends only the input's action on Enter in a sending input inside a sending form", async () => {
		draw(`<form data-pk-send="create">
			<input data-pk-send="search" name="q"><button>Create</button>
		</form>`);
		await userEvent.type(el("input"), "bug{Enter}");
		expect(await nextSend()).toMatchObject({
			action: "search",
			data: { q: "bug" },
		});
		await settle();
		expect(sends()).toEqual([]);
	});

	it("clears a sending input once accepted, and keeps its text when refused", async () => {
		draw('<input data-pk-send="say">');
		const input = el<HTMLInputElement>("input");
		await userEvent.type(input, "hello{Enter}");
		let send = await nextSend();
		expect(send.data).toEqual({ value: "hello" });
		toPage({
			type: "pockode:canvas-send-result",
			id: send.id,
			ok: false,
			code: "offline",
			message: "Not connected",
		});
		await settle();
		expect(input.value).toBe("hello");

		await userEvent.keyboard("{Enter}");
		send = await nextSend();
		toPage({ type: "pockode:canvas-send-result", id: send.id, ok: true });
		await vi.waitFor(() => expect(input.value).toBe(""));
	});

	it("sends nothing on Enter while an input method is composing", async () => {
		draw(
			'<form data-pk-send="create"><input data-pk-send="say" name="q"></form>',
		);
		const input = el<HTMLInputElement>("input");
		input.value = "日本";
		const composing = new KeyboardEvent("keydown", {
			key: "Enter",
			isComposing: true,
			bubbles: true,
			cancelable: true,
		});
		input.dispatchEvent(composing);
		// Safari's keydown that ends a composition is no longer `isComposing`.
		const confirming = new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(confirming, "keyCode", { value: 229 });
		input.dispatchEvent(confirming);
		await settle();
		expect(sends()).toEqual([]);
		expect(composing.defaultPrevented).toBe(false);
		expect(confirming.defaultPrevented).toBe(false);
	});

	it("sends nothing for a click on a sending input, or on a disabled button", async () => {
		draw(`<input data-pk-send="say">
			<button data-pk-send="go" disabled><b>Go</b></button>
			<fieldset disabled><button data-pk-send="go"><b>Go</b></button></fieldset>`);
		await userEvent.click(el("input"));
		// Dispatched, and on a child: `click()` on a disabled control does
		// nothing at all, which would pass without the bridge checking.
		for (const child of document.querySelectorAll("button b")) {
			child.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		}
		await settle();
		expect(sends()).toEqual([]);
	});

	it("submits the form's action on Enter where its first button has its own", async () => {
		draw(`<form data-pk-send="create">
			<input name="title"><button data-pk-send="draft">Draft</button>
		</form>`);
		await userEvent.type(el("input"), "Fix{Enter}");
		expect(await nextSend()).toMatchObject({
			action: "create",
			data: { title: "Fix" },
		});
		await settle();
		expect(sends()).toEqual([]);
	});

	it("submits the form's action on Enter where its first button is in a card that sends", async () => {
		draw(`<form data-pk-send="create">
			<input name="title"><div data-pk-send="card"><button>Card</button></div>
		</form>`);
		await userEvent.type(el("input"), "Fix{Enter}");
		expect((await nextSend()).action).toBe("create");
		await settle();
		expect(sends()).toEqual([]);
	});

	it("submits nothing on Enter where the first button is disabled, as the browser does", async () => {
		draw(`<form data-pk-send="create">
			<input name="title"><button data-pk-send="draft" disabled>Draft</button>
		</form>`);
		await userEvent.type(el("input"), "Fix{Enter}");
		await settle();
		expect(sends()).toEqual([]);
	});

	it("submits a form with no button on Enter, however many fields it has", async () => {
		draw(`<form data-pk-send="create">
			<input name="title"><input name="owner" value="me">
		</form>`);
		await userEvent.type(el("input"), "Fix{Enter}");
		expect(await nextSend()).toMatchObject({
			action: "create",
			data: { title: "Fix", owner: "me" },
		});
	});

	it("sends once for a held Enter", () => {
		draw('<input data-pk-send="say">');
		const repeat = new KeyboardEvent("keydown", {
			key: "Enter",
			repeat: true,
			bubbles: true,
			cancelable: true,
		});
		el("input").dispatchEvent(repeat);
		expect(repeat.defaultPrevented).toBe(true);
		return settle().then(() => expect(sends()).toEqual([]));
	});

	it("keeps what was typed on while the send was out", async () => {
		draw('<input data-pk-send="say">');
		const input = el<HTMLInputElement>("input");
		await userEvent.type(input, "one{Enter}");
		const send = await nextSend();
		await userEvent.type(input, " two");
		toPage({ type: "pockode:canvas-send-result", id: send.id, ok: true });
		await settle();
		expect(input.value).toBe("one two");
	});
});

describe("a sending element that is not a button", () => {
	/** Draws, then lets the bridge's mutation observer see what was drawn. */
	async function drawn(html: string) {
		draw(html);
		await Promise.resolve();
	}

	function key(target: Element, type: "keydown" | "keyup", init = {}) {
		const event = new KeyboardEvent(type, {
			bubbles: true,
			cancelable: true,
			...init,
		});
		target.dispatchEvent(event);
		return event;
	}

	it("is a button with a tab stop, where the page set neither itself", async () => {
		await drawn(`<li data-pk-send="a">A</li>
			<div data-pk-send="b" role="option" tabindex="-1">B</div>
			<div data-pk-send="">empty</div>
			<button data-pk-send="c">C</button>
			<a href="#x" data-pk-send="d">D</a>
			<form data-pk-send="e"><input data-pk-send="f"></form>`);
		const li = el("li");
		expect(li.getAttribute("role")).toBe("button");
		expect(li.getAttribute("tabindex")).toBe("0");
		const own = el("[role=option]");
		expect(own.getAttribute("tabindex")).toBe("-1");
		for (const untouched of document.querySelectorAll(
			'[data-pk-send=""],button,a,form,input',
		)) {
			expect(untouched.hasAttribute("role")).toBe(false);
			expect(untouched.hasAttribute("tabindex")).toBe(false);
		}
		await userEvent.tab();
		expect(document.activeElement).toBe(li);
	});

	it("sends by Enter on press and by Space on release, as a click would", async () => {
		await drawn(
			'<form><input name="q" value="x"><div data-pk-send="open" name="id">Card</div></form>',
		);
		const card = el<HTMLElement>("[data-pk-send]");
		const clicked = vi.fn();
		card.addEventListener("click", clicked);
		card.focus();
		await userEvent.keyboard("{Enter}");
		expect((await nextSend()).action).toBe("open");

		const down = key(card, "keydown", { key: " " });
		expect(down.defaultPrevented).toBe(true);
		await settle();
		expect(sends()).toEqual([]);
		key(card, "keyup", { key: " " });
		const send = await nextSend();
		expect(send).toMatchObject({ action: "open", data: { q: "x" } });
		expect(clicked).toHaveBeenCalledTimes(2);

		await userEvent.keyboard(" ");
		expect((await nextSend()).action).toBe("open");
	});

	it("sends nothing for a held key's repeats, a Space released elsewhere, or a key the page took", async () => {
		await drawn(`<div data-pk-send="open">Card</div><input name="q">`);
		const card = el<HTMLElement>("[data-pk-send]");
		card.focus();
		expect(key(card, "keydown", { key: "Enter", repeat: true })).toMatchObject({
			defaultPrevented: true,
		});
		key(card, "keydown", { key: " " });
		key(card, "keydown", { key: " ", repeat: true });
		el<HTMLInputElement>("input").focus();
		key(el("input"), "keyup", { key: " " });
		key(card, "keyup", { key: " " });

		card.focus();
		const took = (e: Event) => e.preventDefault();
		card.addEventListener("keydown", took);
		key(card, "keydown", { key: "Enter" });
		card.removeEventListener("keydown", took);
		await settle();
		expect(sends()).toEqual([]);
	});

	it("leaves the keys of a field inside it to the field", async () => {
		await drawn(
			'<div data-pk-send="open"><input type="checkbox" name="done"></div>',
		);
		const box = el<HTMLInputElement>("input");
		box.focus();
		await userEvent.keyboard(" ");
		expect(box.checked).toBe(true);
		await settle();
		expect(sends()).toEqual([]);
	});

	// An SVG element has no click() of its own, and a chart's bars are a
	// likely thing for an agent to make press.
	it("presses an SVG element too", async () => {
		await drawn(
			'<svg><rect data-pk-send="bar" width="10" height="10"></rect></svg>',
		);
		const bar = el<SVGRectElement>("rect");
		expect(bar.getAttribute("role")).toBe("button");
		bar.focus();
		await userEvent.keyboard("{Enter}");
		expect((await nextSend()).action).toBe("bar");
		await userEvent.keyboard(" ");
		expect((await nextSend()).action).toBe("bar");
	});

	it("follows what is added or changed later, and gives back only what it gave", async () => {
		await drawn(
			'<div id="a">A</div><div id="b" role="tab">B</div><div id="c" tabindex="0">C</div>',
		);
		const [a, b, c] = [el("#a"), el("#b"), el("#c")];
		for (const pressable of [a, b, c]) {
			pressable.setAttribute("data-pk-send", "x");
		}
		await Promise.resolve();
		expect(a.getAttribute("role")).toBe("button");
		expect(b.getAttribute("role")).toBe("tab");
		expect(b.getAttribute("tabindex")).toBe("0");
		expect(c.getAttribute("role")).toBe("button");
		for (const pressable of [a, b, c]) {
			pressable.removeAttribute("data-pk-send");
		}
		await Promise.resolve();
		expect(a.hasAttribute("role")).toBe(false);
		expect(a.hasAttribute("tabindex")).toBe(false);
		expect(b.getAttribute("role")).toBe("tab");
		expect(b.hasAttribute("tabindex")).toBe(false);
		expect(c.hasAttribute("role")).toBe(false);
		expect(c.getAttribute("tabindex")).toBe("0");

		await drawn('<div data-pk-region="r"></div>');
		received = [];
		toPage({
			type: "pockode:canvas-patch",
			from_revision: 1,
			revision: 2,
			ops: [
				{
					op: "replace",
					region: "r",
					html: '<p><span data-pk-send="z">Z</span></p>',
				},
			],
		});
		await vi.waitFor(() =>
			expect(el("span").getAttribute("role")).toBe("button"),
		);
		expect(el("span").getAttribute("tabindex")).toBe("0");
	});

	it("looks like a plain button: a pointer, the plain hover fill, a focus ring", async () => {
		await drawn(`<div data-pk-send="a" role="option" tabindex="-1">A</div>
			<div data-pk-send="b" class="mine">B</div>
			<style>.mine{background:rgb(9, 9, 9)}</style>`);
		toPage({
			type: "pockode:canvas-theme",
			scheme: "light",
			vars: {
				"--pk-bg-tertiary": "rgb(8, 8, 8)",
				"--pk-accent": "rgb(1, 1, 1)",
			},
		});
		const [card, mine] = document.querySelectorAll("div[data-pk-send]");
		await vi.waitFor(() =>
			expect(
				getComputedStyle(document.documentElement)
					.getPropertyValue("--pk-bg-tertiary")
					.trim(),
			).toBe("rgb(8, 8, 8)"),
		);
		// A role of the page's own: the app's stylesheet, loaded here too,
		// gives every [role=button] a pointer by itself.
		expect(getComputedStyle(card).cursor).toBe("pointer");
		await userEvent.hover(card);
		await vi.waitFor(() =>
			expect(getComputedStyle(card).backgroundColor).toBe("rgb(8, 8, 8)"),
		);
		await userEvent.hover(mine);
		await settle();
		expect(getComputedStyle(mine).backgroundColor).toBe("rgb(9, 9, 9)");
		await userEvent.unhover(mine);
		// At rest it keeps the agent's (here none), never the accent fill.
		await vi.waitFor(() =>
			expect(getComputedStyle(card).backgroundColor).toBe("rgba(0, 0, 0, 0)"),
		);

		await userEvent.tab();
		expect(document.activeElement).toBe(mine);
		expect(mine.matches(":focus-visible")).toBe(true);
		expect(getComputedStyle(mine).outlineStyle).toBe("solid");
		expect(getComputedStyle(mine).outlineColor).toBe("rgb(1, 1, 1)");
	});
});

describe("patches", () => {
	async function patched(ops: unknown[], revision = 2) {
		received = [];
		toPage({
			type: "pockode:canvas-patch",
			from_revision: revision - 1,
			revision,
			ops: ops as never,
		});
		await vi.waitFor(() =>
			expect(received.some((m) => m.type === "pockode:canvas-patched")).toBe(
				true,
			),
		);
		return received.find((m) => m.type === "pockode:canvas-patched");
	}

	it("applies ops in order, leaving what is outside the regions alone", async () => {
		draw(`<input id="field">
			<div data-pk-region="results" class="kept"><p>old</p></div>
			<ul data-pk-region="log"><li>1</li></ul>
			<p data-pk-region="spinner">…</p>`);
		const field = el<HTMLInputElement>("#field");
		await userEvent.type(field, "half-typed");
		expect(
			await patched([
				{
					op: "replace",
					region: "results",
					html: '<span data-pk-region="inner">new</span>',
				},
				{ op: "append", region: "inner", html: "<i>!</i>" },
				{ op: "append", region: "log", html: "<li>2</li>" },
				{ op: "remove", region: "spinner" },
			]),
		).toEqual({ type: "pockode:canvas-patched", revision: 2, ok: true });
		expect(el(".kept").innerHTML).toBe(
			'<span data-pk-region="inner">new<i>!</i></span>',
		);
		expect(el("ul").innerHTML).toBe("<li>1</li><li>2</li>");
		expect(document.querySelector('[data-pk-region="spinner"]')).toBeNull();
		expect(field.value).toBe("half-typed");
		expect(document.activeElement).toBe(field);
	});

	it("parses html in the region's context", async () => {
		draw('<table><tbody data-pk-region="rows"></tbody></table>');
		await patched([
			{ op: "replace", region: "rows", html: "<tr><td>a</td></tr>" },
		]);
		expect(el("tbody").querySelector("tr td")?.textContent).toBe("a");
	});

	it("runs the scripts it inserts, in order", async () => {
		probe.ran = [];
		draw('<div data-pk-region="r"></div>');
		await patched([
			{
				op: "replace",
				region: "r",
				html: '<script>window.ran.push("a")</script><p><script>window.ran.push("b")</script></p>',
			},
			{
				op: "append",
				region: "r",
				html: '<script>window.ran.push("c")</script>',
			},
		]);
		expect(probe.ran).toEqual(["a", "b", "c"]);
	});

	it("runs a src script before what follows it, and scripts in document order", async () => {
		probe.ran = [];
		const src = URL.createObjectURL(
			new Blob(['window.ran.push("src")'], { type: "text/javascript" }),
		);
		draw(`<div data-pk-region="top"></div><div data-pk-region="bottom"></div>`);
		await patched([
			{
				op: "append",
				region: "bottom",
				html: '<script>window.ran.push("bottom")</script>',
			},
			{
				op: "replace",
				region: "top",
				html: `<script src="${src}"></script><script>window.ran.push("after src")</script>`,
			},
		]);
		await vi.waitFor(() =>
			expect(probe.ran).toEqual(["src", "after src", "bottom"]),
		);
		URL.revokeObjectURL(src);
	});

	it("holds the next patch's scripts back behind a src script still loading", async () => {
		probe.ran = [];
		const src = URL.createObjectURL(
			new Blob(['window.ran.push("lib")'], { type: "text/javascript" }),
		);
		draw('<div data-pk-region="r"></div>');
		received = [];
		toPage({
			type: "pockode:canvas-patch",
			from_revision: 1,
			revision: 2,
			ops: [
				{
					op: "replace",
					region: "r",
					html: `<script src="${src}"></script><script>window.ran.push("init")</script>`,
				},
			],
		});
		toPage({
			type: "pockode:canvas-patch",
			from_revision: 2,
			revision: 3,
			ops: [
				{
					op: "append",
					region: "r",
					html: '<script>window.ran.push("render")</script>',
				},
			],
		});
		await vi.waitFor(() =>
			expect(probe.ran).toEqual(["lib", "init", "render"]),
		);
		URL.revokeObjectURL(src);
	});

	it("is held back by no script the engine will not fetch", async () => {
		probe.ran = [];
		draw('<div data-pk-region="r"></div>');
		await patched([
			{
				op: "replace",
				region: "r",
				html: '<script nomodule src="never.js"></script><script type="text/x-template" src="t.html"></script><script>window.ran.push("start")</script>',
			},
		]);
		await vi.waitFor(() => expect(probe.ran).toEqual(["start"]));
	});

	it("keeps a noscript's contents as text, as the page's own parse does", async () => {
		probe.ran = [];
		draw('<div data-pk-region="r"></div>');
		await patched([
			{
				op: "replace",
				region: "r",
				html: '<noscript><script>window.ran.push("noscript")</script></noscript>',
			},
		]);
		await settle();
		expect(probe.ran).toEqual([]);
		expect(el("noscript").children).toHaveLength(0);
	});

	it("applies nothing and runs nothing when a region is missing", async () => {
		probe.ran = [];
		draw(`<div data-pk-region="a"><p>a</p></div>
			<div data-pk-region="b"><p>b</p></div>`);
		const before = page.innerHTML;
		expect(
			await patched([
				{
					op: "replace",
					region: "a",
					html: '<script>window.ran.push("x")</script>',
				},
				{ op: "append", region: "b", html: "<p>more</p>" },
				{ op: "remove", region: "a" },
				{
					op: "append",
					region: "b",
					html: '<img src="data:," onerror="window.ran.push(\'img\')">',
				},
				{ op: "replace", region: "gone", html: "" },
			]),
		).toMatchObject({ ok: false, revision: 2 });
		await settle();
		expect(page.innerHTML).toBe(before);
		expect(probe.ran).toEqual([]);
	});
});

/** The base stylesheet's style rules, each with the media query it is under. */
function baseRules() {
	const sheet = el<HTMLStyleElement>("style[data-pockode-canvas-base]").sheet;
	if (!sheet) throw new Error("no base stylesheet");
	const rules: { rule: CSSStyleRule; media: string | null }[] = [];
	function walk(list: CSSRuleList, media: string | null) {
		for (const rule of Array.from(list)) {
			if (rule instanceof CSSStyleRule) rules.push({ rule, media });
			else if (rule instanceof CSSMediaRule)
				walk(rule.cssRules, rule.conditionText);
			else if (rule instanceof CSSGroupingRule) walk(rule.cssRules, media);
		}
	}
	walk(sheet.cssRules, null);
	return rules;
}

/** Whether the `:where(` a selector opens with is the one it closes with. */
function isWhollyWhere(selector: string) {
	if (!selector.startsWith(":where(")) return false;
	let depth = 0;
	for (let i = ":where".length; i < selector.length; i++) {
		if (selector[i] === "(") depth++;
		else if (selector[i] === ")" && --depth === 0)
			return i === selector.length - 1;
	}
	return false;
}

describe("the page's state", () => {
	it("rewrites the base stylesheet for a theme, which the agent's own rules still win over", async () => {
		const dark: CanvasTheme = {
			scheme: "dark",
			vars: {
				"--pk-bg": "rgb(1, 2, 3)",
				"--pk-text": "rgb(250, 250, 250)",
				"--pk-accent": "rgb(0, 128, 0)",
			},
		};
		draw("<style>:root{--pk-accent:rgb(255, 0, 0)}</style>");
		toPage({ type: "pockode:canvas-theme", ...dark });
		const root = document.documentElement;
		await vi.waitFor(() =>
			expect(getComputedStyle(root).backgroundColor).toBe("rgb(1, 2, 3)"),
		);
		expect(el("style[data-pockode-canvas-base]").textContent).toBe(
			canvasBaseCss(dark),
		);
		expect(getComputedStyle(root).getPropertyValue("--pk-accent").trim()).toBe(
			"rgb(255, 0, 0)",
		);
		expect(root.getAttribute("style")).toBeNull();
		toPage({ type: "pockode:canvas-theme", ...LIGHT });
		await vi.waitFor(() =>
			expect(getComputedStyle(root).backgroundColor).toBe("rgb(255, 255, 255)"),
		);
	});

	it("gives a sending button the accent, which an agent's plain rule overrides", async () => {
		draw(`<style>.mine{background:rgb(9, 9, 9)}</style>
			<button data-pk-send="a">A</button>
			<button data-pk-send="b" class="mine">B</button>
			<form data-pk-send="f"><button type="button">Cancel</button></form>`);
		toPage({
			type: "pockode:canvas-theme",
			scheme: "light",
			vars: {
				"--pk-accent": "rgb(0, 0, 255)",
				"--pk-bg-secondary": "rgb(7, 7, 7)",
			},
		});
		const [a, b, cancel] = document.querySelectorAll("button");
		await vi.waitFor(() =>
			expect(getComputedStyle(a).backgroundColor).toBe("rgb(0, 0, 255)"),
		);
		expect(getComputedStyle(b).backgroundColor).toBe("rgb(9, 9, 9)");
		expect(getComputedStyle(cancel).backgroundColor).toBe("rgb(7, 7, 7)");
	});

	it("makes a press look pressable: a pointer, and the app's own hover fills", async () => {
		// The hover fills are gated on a hovering pointer, which these
		// engines have; without it the hovers below would prove nothing.
		expect(matchMedia(MEDIA_QUERIES.finePointer).matches).toBe(true);
		draw(`<button>Plain</button>
			<button data-pk-send="go">Go</button>
			<form data-pk-send="f"><input type="submit" value="Save"><input type="reset"></form>
			<input type="button" value="Off" disabled>
			<input name="q">`);
		toPage({
			type: "pockode:canvas-theme",
			scheme: "light",
			vars: {
				"--pk-bg-secondary": "rgb(7, 7, 7)",
				"--pk-bg-tertiary": "rgb(8, 8, 8)",
				"--pk-accent": "rgb(1, 1, 1)",
				"--pk-accent-hover": "rgb(2, 2, 2)",
			},
		});
		const [plain, go] = document.querySelectorAll("button");
		const off = el<HTMLInputElement>("input[disabled]");
		const submit = el<HTMLInputElement>("input[type=submit]");
		const reset = el<HTMLInputElement>("input[type=reset]");
		// Not waited for on a pressable: the pointer is wherever the last test
		// left it, which may be over one of these.
		await vi.waitFor(() =>
			expect(
				getComputedStyle(document.documentElement)
					.getPropertyValue("--pk-accent-hover")
					.trim(),
			).toBe("rgb(2, 2, 2)"),
		);
		// The app's stylesheet, loaded here too, gives every <button> a pointer
		// of its own; the inputs are what hold the base stylesheet's.
		for (const pressable of [submit, reset, plain, go]) {
			expect(getComputedStyle(pressable).cursor).toBe("pointer");
		}
		expect(getComputedStyle(el("input[name=q]")).cursor).not.toBe("pointer");
		expect(getComputedStyle(off).cursor).toBe("not-allowed");

		const hovered = [
			[plain, "rgb(8, 8, 8)", "rgb(7, 7, 7)"],
			[reset, "rgb(8, 8, 8)", "rgb(7, 7, 7)"],
			[go, "rgb(2, 2, 2)", "rgb(1, 1, 1)"],
			[submit, "rgb(2, 2, 2)", "rgb(1, 1, 1)"],
		] as const;
		for (const [control, fill, rest] of hovered) {
			await userEvent.hover(control);
			await vi.waitFor(() =>
				expect(getComputedStyle(control).backgroundColor).toBe(fill),
			);
			if (fill === "rgb(2, 2, 2)") {
				expect(getComputedStyle(control).borderTopColor).toBe(fill);
			}
			await userEvent.unhover(control);
			await vi.waitFor(() =>
				expect(getComputedStyle(control).backgroundColor).toBe(rest),
			);
		}

		// Forced: a disabled control takes no pointer events, so hovering it
		// through the driver may be refused rather than shown.
		await userEvent.hover(off, { force: true });
		await settle();
		expect(off.matches(":hover")).toBe(true);
		expect(getComputedStyle(off).backgroundColor).toBe("rgb(7, 7, 7)");
	});

	it("leaves an agent's own fill on hover", async () => {
		draw(`<style>.mine{background:rgb(9, 9, 9)}</style>
			<button class="mine">Mine</button>`);
		const mine = el("button");
		await userEvent.hover(mine);
		await settle();
		expect(mine.matches(":hover")).toBe(true);
		expect(getComputedStyle(mine).backgroundColor).toBe("rgb(9, 9, 9)");
	});

	it("weighs nothing: every selector is wholly one :where()", () => {
		const loose = baseRules()
			.map(({ rule }) => rule.selectorText)
			.filter((selector) => !isWhollyWhere(selector));
		expect(loose).toEqual([]);
	});

	it("hovers only on a pointer that can, and transitions only where motion is welcome", () => {
		const rules = baseRules();
		const hovers = rules.filter(({ rule }) =>
			rule.selectorText.includes(":hover"),
		);
		expect(hovers.length).toBeGreaterThan(0);
		for (const { media } of hovers) {
			expect(media).toBe(MEDIA_QUERIES.finePointer);
		}

		const transitions = rules.filter(
			({ rule }) => rule.style.transitionDuration !== "",
		);
		const moving = transitions.filter(({ media }) => media === null);
		const still = transitions.filter(
			({ media }) => media === "(prefers-reduced-motion: reduce)",
		);
		expect(moving.length).toBeGreaterThan(0);
		expect(still.map(({ rule }) => rule.selectorText)).toEqual(
			moving.map(({ rule }) => rule.selectorText),
		);
		for (const { rule } of still) {
			expect(rule.style.transitionProperty).toBe("none");
		}
	});

	it("loses to an agent's rule in a cascade layer of its own", async () => {
		draw(`<style>@layer agent{button{background:rgb(4, 4, 4)}:root{--pk-text:rgb(5, 5, 5)}}</style>
			<button>Plain</button>`);
		expect(getComputedStyle(el("button")).backgroundColor).toBe("rgb(4, 4, 4)");
		expect(
			getComputedStyle(document.documentElement)
				.getPropertyValue("--pk-text")
				.trim(),
		).toBe("rgb(5, 5, 5)");
	});

	it("reflects whether it can send on the root", async () => {
		const root = document.documentElement;
		toPage({
			type: "pockode:canvas-sendable",
			sendable: false,
			reason: "permission",
		});
		await vi.waitFor(() =>
			expect(root.getAttribute("data-pk-blocked")).toBe("permission"),
		);
		toPage({ type: "pockode:canvas-sendable", sendable: false });
		await vi.waitFor(() =>
			expect(root.getAttribute("data-pk-blocked")).toBe(""),
		);
		toPage({ type: "pockode:canvas-sendable", sendable: true });
		await vi.waitFor(() =>
			expect(root.hasAttribute("data-pk-blocked")).toBe(false),
		);
	});

	it("reports whether what has focus is editable, once per change", async () => {
		draw(`<input id="text"><input id="box" type="checkbox">
			<input id="fixed" readonly value="x"><select><option>a</option></select>
			<textarea></textarea><div contenteditable>x</div>`);
		const focus = () =>
			received.flatMap((m) =>
				m.type === "pockode:canvas-focus" ? [m.editable] : [],
			);
		await userEvent.click(el("#text"));
		await vi.waitFor(() => expect(focus()).toEqual([true]));
		await userEvent.click(el("textarea"));
		await userEvent.click(el("[contenteditable]"));
		await userEvent.click(el("#fixed"));
		await vi.waitFor(() => expect(focus()).toEqual([true, false]));
		// Focused rather than clicked, which would open its picker.
		el<HTMLSelectElement>("select").focus();
		await userEvent.click(el("#box"));
		await vi.waitFor(() => expect(focus()).toEqual([true, false, true, false]));
	});

	it("takes no message from a window other than the app's", async () => {
		draw('<p data-pk-region="r">kept</p>');
		const other = document.createElement("iframe");
		other.srcdoc = `<script>parent.postMessage(${JSON.stringify({
			type: "pockode:canvas-patch",
			from_revision: 1,
			revision: 2,
			ops: [{ op: "remove", region: "r" }],
		})},"*")</script>`;
		const loaded = new Promise((resolve) =>
			other.addEventListener("load", resolve),
		);
		page.append(other);
		await loaded;
		await settle();
		expect(el('[data-pk-region="r"]').textContent).toBe("kept");
	});
});
