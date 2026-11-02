import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
	type PageSendMessage,
	type PageSendResult,
	pageBridgeScript,
	readPageSend,
	sendsToAgent,
} from "./pageBridge";

// Real engines, because what the bridge relies on is theirs: implicit
// submission on Enter and the submitter it names, what `FormData` holds, and
// user activation. The test document is both sides: the bridge runs in it
// with the test's own window as the app, so what it posts arrives here and
// what is posted here is from "the app".

/**
 * The test's window as the page sees it. A cast, not a global declaration,
 * which would type the app's own window as having it too.
 */
const probe = window as unknown as {
	pockode: { send(action: unknown, data?: unknown): Promise<void> };
};

let received: PageSendMessage[] = [];
let page: HTMLElement;

function onMessage(event: MessageEvent) {
	if (event.source !== window) return;
	const message = readPageSend(event.data);
	if (message) received.push(message);
}

beforeAll(() => {
	const script = document.createElement("script");
	script.textContent = pageBridgeScript("window", {
		sends: true,
		themed: false,
	}).replace(/^<script>|<\/script>$/g, "");
	document.head.append(script);
	window.addEventListener("message", onMessage);
	page = document.createElement("div");
	document.body.append(page);
});

afterEach(() => {
	page.innerHTML = "";
	received = [];
});

function draw(html: string) {
	page.innerHTML = html;
}

function toPage(message: PageSendResult) {
	window.postMessage(message, "*");
}

function sends() {
	return received;
}

async function nextSend() {
	await vi.waitFor(() => expect(sends()).toHaveLength(1));
	const [send] = sends();
	received = [];
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

// First in the file: activation is sticky, and every test after this one
// has pressed something.
describe("activation", () => {
	it("says a send is inactive until the reader has used the page, and warns on the refusal", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sent = probe.pockode.send("refresh");
		const send = await nextSend();
		expect(send.active).toBe(false);
		toPage({
			type: "pockode:page-send-result",
			id: send.id,
			ok: false,
			code: "inactive",
			message: "Nothing was sent.",
		});
		await expect(sent).rejects.toMatchObject({ code: "inactive" });
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("pockode.send('refresh')"),
		);
		warn.mockRestore();
	});

	it("says it is active once pressed, a send made later included", async () => {
		draw("<button>Load</button>");
		await userEvent.click(el("button"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		probe.pockode.send("later").catch(() => {});
		expect((await nextSend()).active).toBe(true);
	});
});

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
		toPage({ type: "pockode:page-send-result", id: send.id, ok: true });
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
			type: "pockode:page-send-result",
			id: send.id,
			ok: false,
			code: "awaiting",
			message: "Answer the permission request first.",
		});
		await expect(sent).rejects.toMatchObject({
			code: "awaiting",
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

	it("takes no answer from a window other than the app's", async () => {
		let settled = false;
		probe.pockode.send("save").then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const send = await nextSend();
		const other = document.createElement("iframe");
		other.srcdoc = `<script>parent.postMessage(${JSON.stringify({
			type: "pockode:page-send-result",
			id: send.id,
			ok: true,
		})},"*")</script>`;
		const loaded = new Promise((resolve) =>
			other.addEventListener("load", resolve),
		);
		page.append(other);
		await loaded;
		await settle();
		expect(settled).toBe(false);
	});
});

describe("a plain form", () => {
	it("is cancelled once the page's own handlers have run, and a dialog's is left alone", async () => {
		draw(`<form id="plain"><input name="q"><button>Go</button></form>
			<dialog open><form method="dialog" id="dialog"><button>Close</button></form></dialog>`);
		const heard: { plain?: Event; dialog?: Event } = {};
		const hear = (e: Event) => {
			heard[(e.target as Element).id === "plain" ? "plain" : "dialog"] = e;
		};
		window.addEventListener("submit", hear);
		await userEvent.click(el("#plain button"));
		await userEvent.click(el("#dialog button"));
		await vi.waitFor(() => expect(heard.dialog).toBeDefined());
		expect(heard.plain?.defaultPrevented).toBe(true);
		expect(heard.dialog?.defaultPrevented).toBe(false);
		window.removeEventListener("submit", hear);
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
			type: "pockode:page-send-result",
			id: send.id,
			ok: false,
			code: "offline",
			message: "Not connected",
		});
		await settle();
		expect(input.value).toBe("hello");

		await userEvent.keyboard("{Enter}");
		send = await nextSend();
		toPage({ type: "pockode:page-send-result", id: send.id, ok: true });
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
		toPage({ type: "pockode:page-send-result", id: send.id, ok: true });
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

	it("follows what the page adds or changes later, and gives back only what it gave", async () => {
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
	});
});

describe("sendsToAgent", () => {
	it("is a page whose HTML names the bridge", () => {
		expect(sendsToAgent('<button data-pk-send="go">Go</button>')).toBe(true);
		expect(sendsToAgent("<script>pockode.send('go')</script>")).toBe(true);
		expect(sendsToAgent("<form><button>Go</button></form>")).toBe(false);
	});
});
