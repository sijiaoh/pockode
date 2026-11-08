import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useSearch,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { StrictMode, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ScrollRestorationContext } from "../../hooks/useScrollRestoration";
import { useScrollRestorationScope } from "../../hooks/useScrollRestorationScope";
import { lineAt, lineBox, NUMBERED_CODE_SELECTOR } from "../../lib/codeRows";
import { scrollMemoryFor } from "../../lib/scrollMemory";
import { fileLineCount } from "../../lib/textLines";
import PageBody from "../ui/PageBody";
import FileBody from "./FileBody";

// What jsdom cannot say: where the line lands in a real scroller, and that
// the history's own restoring never fights the landing
// (docs/file.md#where-the-viewer-opens).

const LONG = `const long = "${"x".repeat(300)}";`;
const LINES = 400;

function fixture(lines = LINES): string {
	return `${Array.from({ length: lines }, (_, i) => (i % 7 === 3 ? LONG : `line ${i + 1}`)).join("\n")}\n`;
}

/** The file's contents as a read answers them; null while it is loading. */
let content: string | null = fixture();
const listeners = new Set<() => void>();
function setContent(next: string | null) {
	content = next;
	for (const listener of listeners) listener();
}
function useContent() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => content,
	);
}

/** Highlighted and wrapped, against the default plain and unwrapped. */
let wrapped = false;
/** The reader's wrap setting, changed while the view is up; null follows `wrapped`. */
let wrapSetting: boolean | null = null;
const wrapListeners = new Set<() => void>();
function setWrap(next: boolean) {
	wrapSetting = next;
	for (const listener of wrapListeners) listener();
}
function useWrap() {
	return (
		useSyncExternalStore(
			(listener) => {
				wrapListeners.add(listener);
				return () => wrapListeners.delete(listener);
			},
			() => wrapSetting,
		) ?? wrapped
	);
}
afterEach(() => {
	wrapped = false;
	wrapSetting = null;
});

function Shell() {
	return (
		<ScrollRestorationContext value={useScrollRestorationScope()}>
			<div style={{ display: "flex", flexDirection: "column", height: 480 }}>
				<Outlet />
			</div>
		</ScrollRestorationContext>
	);
}

/** One view for every line, as the file view is: mounted across entries. */
function File() {
	const { line } = useSearch({ strict: false }) as { line?: number };
	const text = useContent();
	const wrap = useWrap();
	return (
		<PageBody>
			{text === null ? (
				<p>loading</p>
			) : (
				<FileBody
					state={{ kind: "text", content: text, highlight: wrapped }}
					path="a.ts"
					lineNumbers
					wrap={wrap}
					line={line}
				/>
			)}
		</PageBody>
	);
}

function renderFile(initial: string) {
	const root = createRootRoute({ component: Shell });
	const router = createRouter({
		routeTree: root.addChildren([
			createRoute({
				getParentRoute: () => root,
				path: "/file",
				component: File,
			}),
		]),
		history: createMemoryHistory({ initialEntries: [initial] }),
	});
	scrollMemoryFor(router.history);
	// As the app runs in development, where every effect runs twice on mount.
	render(
		<StrictMode>
			<RouterProvider router={router} />
		</StrictMode>,
	);
	return router;
}

async function go(router: ReturnType<typeof renderFile>, to: string) {
	await act(() => router.navigate({ to }));
}

async function view() {
	await expect
		.poll(() => document.querySelector(NUMBERED_CODE_SELECTOR))
		.toBeTruthy();
	const pre = document.querySelector<HTMLElement>(NUMBERED_CODE_SELECTOR);
	if (!pre) throw new Error("no numbered block");
	const scroller = pre.closest<HTMLElement>(".overflow-auto");
	if (!scroller) throw new Error("no scroller");
	return { pre, scroller };
}

/** Where line `line` is drawn, from the top of the scroller's viewport. */
function lineOnScreen(pre: HTMLElement, scroller: HTMLElement, line: number) {
	return (
		pre.getBoundingClientRect().top -
		scroller.getBoundingClientRect().top +
		lineBox(pre, line, fileLineCount(pre.textContent ?? "")).top
	);
}

function band() {
	return document.querySelector<HTMLElement>(".line-arrival--band");
}
function number() {
	return document.querySelector<HTMLElement>(".line-arrival--number");
}

async function scrollTo(scroller: HTMLElement, top: number) {
	const scrolled = new Promise((resolve) =>
		scroller.addEventListener("scroll", resolve, { once: true }),
	);
	scroller.scrollTop = top;
	await act(() => scrolled);
}

/** Long enough for any landing or restore still to come to have come. */
function settle() {
	return act(() => new Promise((resolve) => setTimeout(resolve, 100)));
}

describe("a file opened at a line", () => {
	it("lands the line a third of the way down and flashes its row", async () => {
		setContent(fixture());
		renderFile("/file?line=200");
		const { pre, scroller } = await view();

		expect(lineOnScreen(pre, scroller, 200)).toBeCloseTo(
			Math.round(scroller.clientHeight / 3),
			-0.5,
		);
		expect(scroller.scrollLeft).toBe(0);
		const mark = band();
		if (!mark) throw new Error("no mark");
		expect(mark.getBoundingClientRect().top).toBeCloseTo(
			scroller.getBoundingClientRect().top + lineOnScreen(pre, scroller, 200),
			0,
		);
		expect(number()).toHaveAttribute("data-line", "200");
		expect(number()?.getBoundingClientRect().top).toBeCloseTo(
			mark.getBoundingClientRect().top,
			0,
		);
	});

	it("lands a wrapped line a third of the way down and flashes all its rows", async () => {
		wrapped = true;
		setContent(fixture());
		renderFile("/file?line=200");
		const { pre, scroller } = await view();
		const third = Math.round(scroller.clientHeight / 3);

		expect(lineOnScreen(pre, scroller, 200)).toBeCloseTo(third, -0.5);
		const mark = band();
		if (!mark) throw new Error("no mark");
		// Line 200 is a long one, several rows tall.
		const box = lineBox(pre, 200, LINES);
		expect(box.height).toBeGreaterThan(
			1.5 * Number.parseFloat(getComputedStyle(pre).lineHeight),
		);
		expect(mark.getBoundingClientRect().top).toBeCloseTo(
			scroller.getBoundingClientRect().top + lineOnScreen(pre, scroller, 200),
			0,
		);
		expect(mark.getBoundingClientRect().height).toBeCloseTo(box.height, 0);
		expect(number()).toHaveAttribute("data-line", "200");
		expect(number()?.getBoundingClientRect().top).toBeCloseTo(
			mark.getBoundingClientRect().top,
			0,
		);

		// The colours arriving move no row: the landing did not wait for them.
		await expect.poll(() => pre.querySelector(".shiki .line")).toBeTruthy();
		expect(lineOnScreen(pre, scroller, 200)).toBeCloseTo(third, -0.5);
	});

	it("leaves a line near the end lower than a third, at the end of the file", async () => {
		setContent(fixture());
		renderFile(`/file?line=${LINES}`);
		const { scroller } = await view();

		expect(band()).toBeTruthy();
		expect(scroller.scrollTop).toBeCloseTo(
			scroller.scrollHeight - scroller.clientHeight,
			-0.5,
		);
	});

	it("leaves a line near the top where it is", async () => {
		setContent(fixture());
		renderFile("/file?line=2");
		const { scroller } = await view();

		expect(band()).toBeTruthy();
		expect(scroller.scrollTop).toBe(0);
	});

	it("opens a line past the end at the top, unmarked", async () => {
		setContent(fixture());
		renderFile(`/file?line=${LINES + 50}`);
		const { scroller } = await view();
		await settle();

		expect(scroller.scrollTop).toBe(0);
		expect(band()).toBeNull();
		expect(number()).toBeNull();
	});

	it("lands once the content arrives, after the page has started at the top", async () => {
		setContent(fixture());
		const router = renderFile("/file");
		const { scroller } = await view();
		await scrollTo(scroller, 1500);

		act(() => setContent(null));
		await go(router, "/file?line=300");
		await screen.findByText("loading");
		// The reset to the top has been reported and saved by now.
		await settle();
		act(() => setContent(fixture()));

		const { pre } = await view();
		await expect.poll(() => band()).toBeTruthy();
		expect(lineOnScreen(pre, scroller, 300)).toBeCloseTo(
			Math.round(scroller.clientHeight / 3),
			-0.5,
		);
	});

	it("lands again, with a new flash, on another line of the open file", async () => {
		setContent(fixture());
		const router = renderFile("/file?line=100");
		const { pre, scroller } = await view();
		const first = band();
		expect(first).toBeTruthy();

		await go(router, "/file?line=300");
		await settle();

		expect(lineOnScreen(pre, scroller, 300)).toBeCloseTo(
			Math.round(scroller.clientHeight / 3),
			-0.5,
		);
		expect(number()).toHaveAttribute("data-line", "300");
		expect(band()).not.toBe(first);
	});

	it("is back where the reader left it on Back, without a flash", async () => {
		setContent(fixture());
		const router = renderFile("/file?line=100");
		const { scroller } = await view();
		await scrollTo(scroller, scroller.scrollTop + 250);
		const left = scroller.scrollTop;
		await go(router, "/file?line=300");
		await settle();

		await act(async () => router.history.back());
		await settle();

		expect(scroller.scrollTop).toBe(left);
		expect(band()).toBeNull();
	});

	it("does not flash again on a return made while the flash is still running", async () => {
		setContent(fixture());
		const router = renderFile("/file?line=100");
		await view();
		expect(band()).toBeTruthy();
		// A next entry that lands nowhere, so nothing replaces the first mark.
		await go(router, `/file?line=${LINES + 50}`);
		await settle();

		await act(async () => router.history.back());
		await settle();

		expect(band()).toBeNull();
	});

	it("neither scrolls back nor flashes again when the content refreshes", async () => {
		setContent(fixture());
		renderFile("/file?line=200");
		const { scroller } = await view();
		const mark = band();
		await scrollTo(scroller, 50);

		act(() => setContent(`${fixture()}one more\n`));
		await settle();

		expect(scroller.scrollTop).toBe(50);
		// The flash in progress just finishes; it is not started over.
		expect(band() === null || band() === mark).toBe(true);
	});

	it("takes the mark off when its flash ends", async () => {
		setContent(fixture());
		renderFile("/file?line=200");
		await view();
		expect(band()).toBeTruthy();

		await expect.poll(() => band(), { timeout: 4_000 }).toBeNull();
		expect(number()).toBeNull();
	});
});

describe("toggling wrap on an open file", () => {
	/** The line at the top of the scroller, and how far into it the top is. */
	function topLine(pre: HTMLElement, scroller: HTMLElement) {
		const top =
			scroller.getBoundingClientRect().top - pre.getBoundingClientRect().top;
		const line = lineAt(pre, top, LINES);
		const box = lineBox(pre, line, LINES);
		return { line, share: (top - box.top) / box.height, height: box.height };
	}

	/** Within a pixel and a half of the same share: a scroll offset is rounded. */
	function sameShare(
		after: ReturnType<typeof topLine>,
		before: ReturnType<typeof topLine>,
	) {
		expect(after.line).toBe(before.line);
		expect(Math.abs(after.share - before.share) * after.height).toBeLessThan(
			1.5,
		);
	}

	function onWrapped() {
		return (
			document.querySelector(".code-block-wrapper--numbered-wrap") !== null
		);
	}

	it("keeps the line at the top of the page, both ways", async () => {
		wrapped = true;
		setContent(fixture());
		renderFile("/file");
		const { pre, scroller } = await view();
		await expect.poll(() => pre.querySelector(".shiki .line")).toBeTruthy();
		// A third of the way into a long line, several rows tall when wrapped.
		const long = lineBox(pre, 200, LINES);
		await scrollTo(
			scroller,
			scroller.scrollTop + lineOnScreen(pre, scroller, 200) + long.height / 3,
		);
		const wrappedTop = topLine(pre, scroller);
		expect(wrappedTop.line).toBe(200);

		act(() => setWrap(false));
		expect(onWrapped()).toBe(false);
		sameShare(topLine(pre, scroller), wrappedTop);

		// Elsewhere, and sideways, which a wrapped view has no room for.
		await scrollTo(
			scroller,
			scroller.scrollTop + lineOnScreen(pre, scroller, 300) + 5,
		);
		scroller.scrollLeft = 100;
		expect(scroller.scrollLeft).toBe(100);
		const before = topLine(pre, scroller);
		expect(before.line).toBe(300);

		act(() => setWrap(true));
		expect(onWrapped()).toBe(true);
		sameShare(topLine(pre, scroller), before);
		expect(scroller.scrollLeft).toBe(0);
	});

	it("drops a running flash, measured in the layout it leaves", async () => {
		wrapped = true;
		setContent(fixture());
		renderFile("/file?line=200");
		const { pre, scroller } = await view();
		expect(band()).toBeTruthy();
		const before = topLine(pre, scroller);

		act(() => setWrap(false));

		expect(band()).toBeNull();
		expect(number()).toBeNull();
		expect(topLine(pre, scroller).line).toBe(before.line);
	});
});
