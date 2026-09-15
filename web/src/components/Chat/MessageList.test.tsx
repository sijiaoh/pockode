import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, QuestionStatus } from "../../types/message";
import MessageList from "./MessageList";

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { workDir: string }) => string) =>
		selector({ workDir: "/tmp/project" }),
}));

/**
 * Records every observer so tests can drive intersection callbacks by hand;
 * jsdom has no layout, so visibility can only be simulated.
 */
class MockIntersectionObserver {
	static instances: MockIntersectionObserver[] = [];
	/** Targets a test has put on screen; see `observe`. */
	static inView = new Set<Element>();
	targets = new Set<Element>();

	callback: IntersectionObserverCallback;

	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
		MockIntersectionObserver.instances.push(this);
	}

	observe(target: Element) {
		this.targets.add(target);
		// A real observer reports a target that is already intersecting as soon as
		// it starts watching it, and that is the whole mechanism behind paging on:
		// re-observing a sentinel still on screen is what asks for the next page.
		// No act() here — the report only reaches refs and the callback prop, and
		// every caller below is inside one already.
		if (MockIntersectionObserver.inView.has(target)) {
			this.callback(
				[{ target, isIntersecting: true } as IntersectionObserverEntry],
				this as unknown as IntersectionObserver,
			);
		}
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
		MockIntersectionObserver.instances =
			MockIntersectionObserver.instances.filter((i) => i !== this);
	}
	takeRecords() {
		return [];
	}
}

/**
 * Records every observer and the boxes it watches, so a test can say which box
 * changed size. jsdom resizes nothing on its own, and which box is watched is
 * itself part of the contract here.
 */
class MockResizeObserver {
	static instances: MockResizeObserver[] = [];
	targets = new Set<Element>();

	callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		MockResizeObserver.instances.push(this);
	}

	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
		MockResizeObserver.instances = MockResizeObserver.instances.filter(
			(i) => i !== this,
		);
	}
}

/** Reports a resize of `target` to whoever is actually watching it. */
function triggerResize(target: Element) {
	for (const observer of MockResizeObserver.instances) {
		if (!observer.targets.has(target)) continue;
		act(() => {
			observer.callback(
				[{ target } as ResizeObserverEntry],
				observer as unknown as ResizeObserver,
			);
		});
	}
}

interface Viewport {
	contentHeight: number;
	viewportHeight: number;
}

/**
 * jsdom lays nothing out, so the two heights that decide "at bottom" have to be
 * supplied by hand. The returned box stays live: a test grows the content or
 * shrinks the viewport by writing to it.
 */
function stubViewport(el: HTMLElement, viewport: Viewport): Viewport {
	Object.defineProperty(el, "scrollHeight", {
		configurable: true,
		get: () => viewport.contentHeight,
	});
	Object.defineProperty(el, "clientHeight", {
		configurable: true,
		get: () => viewport.viewportHeight,
	});
	return viewport;
}

/** A drag, and then the scroll event the browser would dispatch after it. */
function dragTo(el: HTMLElement, scrollTop: number) {
	fireEvent.wheel(el);
	el.scrollTop = scrollTop;
	fireEvent.scroll(el);
}

/**
 * The box holding the messages, which is the scroller's only child. Which of
 * the two resizes is the whole point of several tests below: the content grows
 * as output streams in, the container shrinks under the software keyboard.
 */
function contentBox(scroller: HTMLElement): Element {
	const el = scroller.firstElementChild;
	if (!el) throw new Error("no content box");
	return el;
}

function questionCard(requestId: string): HTMLElement | null {
	for (const el of document.querySelectorAll<HTMLElement>(
		"[data-question-request-id]",
	)) {
		if (el.dataset.questionRequestId === requestId) return el;
	}
	return null;
}

function reportVisibility(
	requestId: string,
	visible: boolean,
	direction: "up" | "down" = "up",
) {
	const header = questionCard(requestId)?.querySelector(
		"[data-question-header]",
	);
	if (!header) throw new Error(`no rendered question card for ${requestId}`);

	const rootTop = 100;
	const entry = {
		target: header,
		intersectionRatio: visible ? 1 : 0,
		isIntersecting: visible,
		rootBounds: { top: rootTop } as DOMRectReadOnly,
		boundingClientRect: {
			top: direction === "up" ? rootTop - 50 : rootTop + 500,
		} as DOMRectReadOnly,
		intersectionRect: {} as DOMRectReadOnly,
		time: 0,
	} as IntersectionObserverEntry;

	for (const observer of MockIntersectionObserver.instances) {
		if (!observer.targets.has(header)) continue;
		act(() => {
			observer.callback([entry], observer as unknown as IntersectionObserver);
		});
	}
}

/** Height every message row is given below, so scroll maths has numbers. */
const ROW_HEIGHT = 100;

/**
 * Lays the rows out at `factor` times their normal height. jsdom lays nothing
 * out, so a row's position in the list is the only thing the scroll anchor has
 * to work from; growing it is how a page that finishes rendering after it landed
 * is expressed.
 */
function stretchRows(factor: number) {
	Object.defineProperty(HTMLElement.prototype, "offsetTop", {
		configurable: true,
		get(this: HTMLElement) {
			if (!this.dataset.messageId) return 0;
			const rows = [...document.querySelectorAll("[data-message-id]")];
			return rows.indexOf(this) * ROW_HEIGHT * factor;
		},
	});
}

/**
 * Lays the rows on the bottom edge of the viewport, which is where `justify-end`
 * holds them while the transcript is shorter than it. A page landing above then
 * fills space that was empty and leaves every row already on screen exactly
 * where it was — the state the paging gate cannot ask "did the view move?" in.
 */
function bottomAlignRows(viewportHeight: number) {
	Object.defineProperty(HTMLElement.prototype, "offsetTop", {
		configurable: true,
		get(this: HTMLElement) {
			if (!this.dataset.messageId) return 0;
			const rows = [...document.querySelectorAll("[data-message-id]")];
			return (
				viewportHeight -
				rows.length * ROW_HEIGHT +
				rows.indexOf(this) * ROW_HEIGHT
			);
		},
	});
}

function scrollContainer(): HTMLElement {
	const el = document.querySelector<HTMLElement>(".overflow-y-auto");
	if (!el) throw new Error("no scroll container");
	return el;
}

/**
 * Scrolls the top-of-history sentinel into view, as reading back up does. It is
 * the only observed node outside a question card, which is what tells the two
 * apart. It stays in view until a test says otherwise, so that any observer
 * armed afterwards reports it the way a real one would.
 */
function triggerHistorySentinel() {
	for (const observer of MockIntersectionObserver.instances) {
		for (const target of observer.targets) {
			if (target.closest("[data-question-request-id]")) continue;
			MockIntersectionObserver.inView.add(target);
			act(() => {
				observer.callback(
					[{ target, isIntersecting: true } as IntersectionObserverEntry],
					observer as unknown as IntersectionObserver,
				);
			});
		}
	}
}

/** The page that landed pushed the sentinel back off the top of the view. */
function sentinelLeftView() {
	MockIntersectionObserver.inView.clear();
}

function questionMessage(
	id: string,
	requestId: string,
	status: QuestionStatus = "pending",
): Message {
	return {
		id,
		role: "assistant",
		status: "complete",
		createdAt: new Date(),
		parts: [
			{
				type: "ask_user_question",
				request: {
					requestId,
					toolUseId: `tool-${requestId}`,
					questions: [
						{
							question: "Which one?",
							header: `Pick ${requestId}`,
							options: [{ label: "A", description: "a" }],
							multiSelect: false,
						},
					],
				},
				status,
			},
		],
	};
}

function textMessage(id: string): Message {
	return {
		id,
		role: "assistant",
		status: "complete",
		createdAt: new Date(),
		parts: [{ type: "text", content: `text ${id}` }],
	};
}

function renderList(messages: Message[]) {
	return render(<MessageList messages={messages} isProcessRunning={false} />);
}

const pill = () =>
	screen.queryByRole("button", { name: /unanswered question/i });

// Showing the pill is debounced by 250ms of real time, and these tests render a
// fair amount of DOM; the default 1000ms leaves no headroom on a loaded machine
// and turns every wait for the pill into a flake.
const findPill = (name: string) =>
	screen.findByRole("button", { name }, { timeout: 3000 });

function userMessage(id: string): Message {
	return {
		id,
		role: "user",
		content: `typed ${id}`,
		status: "complete",
		createdAt: new Date(),
	};
}

beforeEach(() => {
	MockIntersectionObserver.instances = [];
	MockIntersectionObserver.inView.clear();
	globalThis.IntersectionObserver =
		MockIntersectionObserver as unknown as typeof globalThis.IntersectionObserver;
	MockResizeObserver.instances = [];
	globalThis.ResizeObserver =
		MockResizeObserver as unknown as typeof globalThis.ResizeObserver;
	Element.prototype.scrollIntoView = vi.fn();
	// A smooth scroll moves nothing synchronously even in a real browser, and
	// jsdom runs no animation at all, so the frames it would produce are driven
	// by hand below.
	Element.prototype.scrollTo = vi.fn();

	// jsdom has no layout, so the two things the scroll anchor is made of have to
	// be supplied: a row's position in the list, and a scroll offset that is
	// remembered rather than dropped.
	stretchRows(1);
	let scrollTop = 0;
	Object.defineProperty(HTMLElement.prototype, "scrollTop", {
		configurable: true,
		get: () => scrollTop,
		set: (value: number) => {
			scrollTop = value;
		},
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("MessageList pending question pill", () => {
	it("stays hidden while the question is in view", async () => {
		renderList([questionMessage("m1", "r1")]);
		reportVisibility("r1", true);

		// Long enough for the show debounce to have fired.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(pill()).not.toBeInTheDocument();

		// Proves the absence above came from the visibility rule and not from a
		// debounce that simply had not run yet.
		reportVisibility("r1", false);
		expect(await findPill("Jump to unanswered question")).toBeInTheDocument();
	});

	it("stays hidden until the observer has reported on a rendered question", async () => {
		renderList([questionMessage("m1", "r1")]);

		// No intersection callback yet. A rendered card is assumed on screen, so
		// the pill must not flash over a question the user may be looking at.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(pill()).not.toBeInTheDocument();
	});

	it("appears once the question scrolls out of view", async () => {
		renderList([questionMessage("m1", "r1")]);
		reportVisibility("r1", false);

		expect(await findPill("Jump to unanswered question")).toBeInTheDocument();
		expect(screen.getByText("Question waiting")).toBeInTheDocument();
	});

	it("disappears once the question is answered", async () => {
		const { rerender } = renderList([questionMessage("m1", "r1")]);
		reportVisibility("r1", false);
		await findPill("Jump to unanswered question");

		rerender(
			<MessageList
				messages={[questionMessage("m1", "r1", "answered")]}
				isProcessRunning={false}
			/>,
		);
		await waitFor(() => expect(pill()).not.toBeInTheDocument());
	});

	it("counts only the questions that are out of view, and jumps to the first", async () => {
		renderList([questionMessage("m1", "r1"), questionMessage("m2", "r2")]);
		reportVisibility("r1", false);
		reportVisibility("r2", true);

		const button = await findPill("Jump to unanswered question");
		expect(screen.getByText("Question waiting")).toBeInTheDocument();

		await userEvent.click(button);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
		expect(questionCard("r1")).toHaveClass("question-highlight");
		expect(
			questionCard("r1")?.querySelector("[data-question-header]"),
		).toHaveFocus();
	});

	it("moves the highlight rather than leaving it on the previous target", async () => {
		renderList([questionMessage("m1", "r1"), questionMessage("m2", "r2")]);
		reportVisibility("r1", false);
		reportVisibility("r2", false);

		const button = await findPill("Jump to 2 unanswered questions");
		await userEvent.click(button);
		expect(questionCard("r1")).toHaveClass("question-highlight");

		// The first question is now in view, so the pill points at the second.
		reportVisibility("r1", true);
		await userEvent.click(await findPill("Jump to unanswered question"));

		expect(questionCard("r2")).toHaveClass("question-highlight");
		expect(questionCard("r1")).not.toHaveClass("question-highlight");
	});

	it("jumps to a question that is loaded but out of view", async () => {
		const messages: Message[] = [
			questionMessage("m0", "r1"),
			...Array.from({ length: 80 }, (_, i) => textMessage(`m${i + 1}`)),
		];
		renderList(messages);
		reportVisibility("r1", false);

		await userEvent.click(await findPill("Jump to unanswered question"));

		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
		expect(questionCard("r1")).toHaveClass("question-highlight");
		// Proxy for the internal at-bottom flag having been dropped: an auto-follow
		// that still believed the user was at the tail would scroll straight back
		// down over the jump.
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
	});
});

describe("MessageList history paging", () => {
	/** Past the window a restore keeps correcting itself in. */
	const SETTLED = 1000;
	const loaded = [textMessage("m1"), textMessage("m2")];
	const pagedIn = [textMessage("older1"), textMessage("older2"), ...loaded];

	function renderPaging() {
		const onLoadMoreHistory = vi.fn();
		const props = {
			isProcessRunning: false,
			hasMoreHistory: true,
			onLoadMoreHistory,
		};
		const { rerender } = render(
			<MessageList {...props} messages={loaded} loadedHistoryPages={0} />,
		);
		const scroller = scrollContainer();
		return {
			onLoadMoreHistory,
			props,
			rerender,
			scroller,
			// More content than the view holds, so there is something for a page to
			// push the view over. The case where there is not is its own test.
			viewport: stubViewport(scroller, {
				contentHeight: 1000,
				viewportHeight: 500,
			}),
		};
	}

	it("asks for an earlier page when the top of the loaded history comes into view", () => {
		const { onLoadMoreHistory } = renderPaging();

		triggerHistorySentinel();
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);
	});

	it("holds the view over the messages already on screen when a page lands above them", () => {
		const { scroller, rerender, props } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;

		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);

		// Two rows went in above the row the view was pinned to, so the view has
		// to move down by exactly two rows to stay on it.
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);
	});

	it("keeps correcting the restore while the page that landed is still rendering", () => {
		const { scroller, rerender, props } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;
		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);

		// A diagram inside the page that just landed finishes rendering, and every
		// row above the anchor doubles in height. The restore was measured before
		// any of that, so on its own it now sits a page-worth too high.
		stretchRows(2);
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(ROW_HEIGHT + 4 * ROW_HEIGHT);

		// Once the reader takes over, the view is theirs: a late correction here
		// would pull them off whatever they scrolled to.
		dragTo(scroller, 42);
		stretchRows(3);
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(42);
	});

	it("waits for the restore to settle before asking for another page", () => {
		vi.useFakeTimers();
		const { scroller, rerender, props, onLoadMoreHistory } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;
		triggerHistorySentinel();
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		// Two rows is less than the view holds, so the sentinel is still on screen.
		// Asking again right here — which is what re-observing on the page itself
		// used to do — is the loop: every page that fails to move the view asks for
		// the next one in the same frame.
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);

		act(() => vi.advanceTimersByTime(SETTLED));
		// The page did move the view, so reading on is what the reader asked for.
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(2);
	});

	it("stops asking once the page that landed has filled the view", () => {
		vi.useFakeTimers();
		const { scroller, rerender, props, onLoadMoreHistory } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;
		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		sentinelLeftView();

		act(() => vi.advanceTimersByTime(SETTLED));
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);
	});

	it("keeps filling a viewport the transcript does not reach the bottom of", () => {
		vi.useFakeTimers();
		const { rerender, props, scroller, viewport, onLoadMoreHistory } =
			renderPaging();
		// Nothing to scroll: the content box is `min-h-full`, so a transcript this
		// short leaves the view pinned at 0 however well the page restores, and the
		// rows it holds on the bottom edge do not move either. Asking the view to
		// have moved would stop the filling that gets a short conversation onto the
		// screen in the first place.
		viewport.contentHeight = 500;
		bottomAlignRows(viewport.viewportHeight);
		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		expect(scroller.scrollTop).toBe(0);

		act(() => vi.advanceTimersByTime(SETTLED));
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(2);
	});

	it("lets a jump back to the tail end the restore it interrupts", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		dragTo(scroller, 0);
		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		expect(scroller.scrollTop).toBe(2 * ROW_HEIGHT);

		// The button is not inside the scroller, so no gesture reaches it: the
		// window has to be ended by the scroll it starts saying so itself. Clicked
		// synchronously, because the window closes on a real 500ms timer and an
		// awaited click would let it expire — which would leave nothing for this
		// test to catch.
		fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));

		// The page that landed finishes rendering. Correcting it now would undo the
		// jump the user just asked for.
		stretchRows(2);
		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(1400);
	});

	it("stops cleanly once the server says there is nothing older", () => {
		vi.useFakeTimers();
		const { rerender, props, scroller, onLoadMoreHistory } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;
		triggerHistorySentinel();

		// The last page, and with it the sentinel: nothing is left to observe, so
		// nothing can ask again however the restore turned out.
		rerender(
			<MessageList
				{...props}
				hasMoreHistory={false}
				messages={pagedIn}
				loadedHistoryPages={1}
			/>,
		);

		act(() => vi.advanceTimersByTime(SETTLED));
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Beginning of conversation")).toBeInTheDocument();
	});

	it("stops paging when a page leaves the view where it was, and waits to be asked again", () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { scroller, rerender, props, onLoadMoreHistory } = renderPaging();
		// Read right up to the top, which is where the loop used to pin the view.
		scroller.scrollTop = 0;
		triggerHistorySentinel();

		// A page whose records render to nothing: the cursor moved on, the
		// transcript did not, and the sentinel is still exactly where it was.
		rerender(
			<MessageList {...props} messages={loaded} loadedHistoryPages={1} />,
		);
		expect(scroller.scrollTop).toBe(0);

		act(() => vi.advanceTimersByTime(SETTLED));
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);
		// Paging stopping is not something to keep to itself.
		expect(warn).toHaveBeenCalled();

		// Not a dead end: the reader asking for more starts it again, and one
		// gesture buys one page, which is what the runaway never had.
		fireEvent.wheel(scroller);
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(2);
	});

	it("restores by height, and says so, when the anchored message is gone", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { scroller, rerender, props, viewport } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;
		triggerHistorySentinel();

		// The page landed, but the row the anchor was pinned to is not in the list
		// any more. Staying put would leave the view against the sentinel, asking
		// for page after page, and saying nothing about why.
		viewport.contentHeight = 1400;
		rerender(
			<MessageList
				{...props}
				messages={[textMessage("older1"), textMessage("older2"), loaded[1]]}
				loadedHistoryPages={1}
			/>,
		);

		expect(scroller.scrollTop).toBe(ROW_HEIGHT + 400);
		expect(warn).toHaveBeenCalled();
	});

	it("offers a retry instead of quietly stopping when a page fails", async () => {
		const onLoadMoreHistory = vi.fn();
		render(
			<MessageList
				messages={[textMessage("m1")]}
				isProcessRunning={false}
				hasMoreHistory
				historyError="Failed to load earlier messages: connection lost"
				onLoadMoreHistory={onLoadMoreHistory}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("connection lost");
		// Nothing left to observe, so the failure cannot spin into a retry loop
		// the user never asked for.
		triggerHistorySentinel();
		expect(onLoadMoreHistory).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);
	});

	it("says where the conversation starts, but only once the user has paged back", () => {
		const { rerender } = render(
			<MessageList messages={[textMessage("m1")]} isProcessRunning={false} />,
		);
		expect(screen.queryByText("Beginning of conversation")).toBeNull();

		rerender(
			<MessageList
				messages={[textMessage("m1")]}
				isProcessRunning={false}
				loadedHistoryPages={1}
			/>,
		);
		expect(screen.getByText("Beginning of conversation")).toBeInTheDocument();
	});
});

describe("MessageList following the tail", () => {
	const transcript = Array.from({ length: 5 }, (_, i) =>
		textMessage(`m${i + 1}`),
	);

	// Twice the viewport of content, scrolled right to the end: 1000 - 500 - 500
	// leaves nothing below, so the view starts out at the tail and following.
	function renderFollowing() {
		const view = renderList(transcript);
		const scroller = scrollContainer();
		const viewport = stubViewport(scroller, {
			contentHeight: 1000,
			viewportHeight: 500,
		});
		scroller.scrollTop = 500;
		fireEvent.scroll(scroller);
		return { ...view, scroller, viewport };
	}

	it("leaves the view where the user scrolled it while the content keeps growing", () => {
		const { scroller, viewport } = renderFollowing();

		dragTo(scroller, 200);

		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));

		expect(scroller.scrollTop).toBe(200);
	});

	it("follows again once the user scrolls back to the bottom", () => {
		const { scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		dragTo(scroller, 500);

		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(1400);
	});

	it("pins the tail again when the viewport shrinks under it", () => {
		const { scroller, viewport } = renderFollowing();

		// The software keyboard opens, or the input box grows a line: the content
		// is untouched, only the container it is read through gets shorter.
		viewport.viewportHeight = 250;
		triggerResize(scroller);

		expect(scroller.scrollTop).toBe(1000);
	});

	it("keeps the scroll-to-bottom button following as the content settles", async () => {
		const { scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		await userEvent.click(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		);

		// A frame of the scroll the button started: off the tail, but nobody's
		// gesture, so it must not be read as the user leaving again.
		scroller.scrollTop = 300;
		fireEvent.scroll(scroller);

		// Syntax highlighting lands and the bottom moves past the offset the
		// animation was aimed at. The view has to end up at the new bottom, not at
		// the one that was current when the button was pressed.
		viewport.contentHeight = 1500;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(1500);
	});

	it("does not resume following when a jump lands near the tail", async () => {
		const question = questionMessage("q1", "r1");
		render(
			<MessageList
				messages={[...transcript, question]}
				isProcessRunning={false}
			/>,
		);
		const scroller = scrollContainer();
		const viewport = stubViewport(scroller, {
			contentHeight: 1000,
			viewportHeight: 500,
		});
		dragTo(scroller, 200);
		reportVisibility("r1", false);

		await userEvent.click(await findPill("Jump to unanswered question"));

		// The jump is aimed at a question close to the end of the transcript, so
		// the scroll it starts comes to rest at the tail. That is the jump's doing,
		// not the user's, and must not be read as them choosing to follow again.
		scroller.scrollTop = 500;
		fireEvent.scroll(scroller);

		// Otherwise the next reflow of streaming output drags the question the user
		// just asked to see straight back off the screen.
		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(500);
	});

	it("leaves a freshly paged-in view where the restore put it", () => {
		const props = {
			isProcessRunning: false,
			hasMoreHistory: true,
			onLoadMoreHistory: vi.fn(),
		};
		const { rerender } = render(
			<MessageList
				{...props}
				messages={[textMessage("m1"), textMessage("m2")]}
				loadedHistoryPages={0}
			/>,
		);
		const scroller = scrollContainer();
		const viewport = stubViewport(scroller, {
			contentHeight: 1000,
			viewportHeight: 500,
		});

		// Reading back up to the top is what brings the sentinel into view at all.
		dragTo(scroller, 0);
		triggerHistorySentinel();

		rerender(
			<MessageList
				{...props}
				messages={[
					textMessage("older1"),
					textMessage("older2"),
					textMessage("m1"),
					textMessage("m2"),
				]}
				loadedHistoryPages={1}
			/>,
		);
		expect(scroller.scrollTop).toBe(2 * ROW_HEIGHT);

		// The page that just landed finishes rendering. The user is reading up
		// here, so this must not be taken as licence to jump to the bottom.
		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(2 * ROW_HEIGHT);
	});

	it("returns to the tail when the user sends a message from further up", () => {
		const { rerender, scroller } = renderFollowing();
		dragTo(scroller, 200);

		rerender(
			<MessageList
				messages={[...transcript, userMessage("sent")]}
				isProcessRunning={false}
			/>,
		);

		expect(scroller.scrollTop).toBe(1000);
	});
});
