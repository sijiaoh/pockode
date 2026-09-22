import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types/message";
import MessageList, { type MessageListHandle } from "./MessageList";

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

function permissionCard(requestId: string): HTMLElement | null {
	for (const el of document.querySelectorAll<HTMLElement>(
		"[data-permission-request-id]",
	)) {
		if (el.dataset.permissionRequestId === requestId) return el;
	}
	return null;
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
	layoutRows(() => ROW_HEIGHT * factor);
}

/**
 * Lays the rows out from a height per row, for the cases where they are not all
 * the same: a page merged into the message it landed above grows that one row
 * and no other.
 */
function layoutRows(height: (messageId: string) => number) {
	Object.defineProperty(HTMLElement.prototype, "offsetTop", {
		configurable: true,
		get(this: HTMLElement) {
			if (!this.dataset.messageId) return 0;
			let top = 0;
			for (const row of document.querySelectorAll<HTMLElement>(
				"[data-message-id]",
			)) {
				if (row === this) break;
				top += height(row.dataset.messageId ?? "");
			}
			return top;
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
 * the only node the list observes at all now, so nothing has to be told apart
 * from it. It stays in view until a test says otherwise, so that any observer
 * armed afterwards reports it the way a real one would.
 */
function triggerHistorySentinel() {
	for (const observer of MockIntersectionObserver.instances) {
		for (const target of observer.targets) {
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

function questionMessage(id: string, requestId: string): Message {
	return {
		id,
		role: "assistant",
		status: "complete",
		createdAt: new Date(),
		parts: [
			{
				type: "question_record",
				record: {
					requestId,
					question: {
						question: "Which one?",
						header: `Pick ${requestId}`,
						options: [{ label: "A", description: "a" }],
						multiSelect: false,
					},
				},
				status: "pending",
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
	return render(<MessageList sessionId="session-1" messages={messages} />);
}

function permissionMessage(id: string, requestId: string): Message {
	return {
		id,
		role: "assistant",
		status: "complete",
		createdAt: new Date(),
		parts: [
			{
				type: "permission_request",
				status: "pending",
				request: {
					requestId,
					toolUseId: `tool-${requestId}`,
					toolName: "Edit",
					toolInput: { file_path: "/etc/hosts" },
				},
			},
		],
	};
}

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

// The attention strip reaches the card holding the turn up through this jump, and
// it lives below the list, so the list exposes the one it already owns rather
// than a second scroll-and-highlight being written beside it
// (docs/lifecycle-ui.md §2.2).
//
// A permission request is the only card it reaches: answering a posted question
// happens in the sheet, and there is deliberately no jump to a question card
// (docs/answering-ui.md §8).
describe("the jump the attention strip borrows", () => {
	it("reaches a permission request, focus included", () => {
		const ref = createRef<MessageListHandle>();
		render(
			<MessageList
				ref={ref}
				sessionId="session-1"
				messages={[permissionMessage("m1", "p1")]}
			/>,
		);

		act(() => ref.current?.jumpToRequest("p1"));

		const card = permissionCard("p1");
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
		expect(card).toHaveClass("jump-highlight");
		// Without a focus move the jump is one a keyboard user cannot perceive.
		expect(card?.querySelector("button")).toHaveFocus();
	});

	it("moves the highlight rather than leaving it on the previous target", () => {
		const ref = createRef<MessageListHandle>();
		render(
			<MessageList
				ref={ref}
				sessionId="session-1"
				messages={[
					permissionMessage("m1", "p1"),
					permissionMessage("m2", "p2"),
				]}
			/>,
		);

		act(() => ref.current?.jumpToRequest("p1"));
		expect(permissionCard("p1")).toHaveClass("jump-highlight");

		act(() => ref.current?.jumpToRequest("p2"));
		expect(permissionCard("p2")).toHaveClass("jump-highlight");
		expect(permissionCard("p1")).not.toHaveClass("jump-highlight");
	});

	// A question card carries no jump handle at all, so the jump finds nothing
	// and — this is the part worth pinning — does nothing: it must not move the
	// view or drop the follow flag on the strength of an id it cannot place.
	it("does nothing for a request id no card carries", () => {
		const ref = createRef<MessageListHandle>();
		render(
			<MessageList
				ref={ref}
				sessionId="session-1"
				messages={[questionMessage("m1", "r1")]}
			/>,
		);

		act(() => ref.current?.jumpToRequest("r1"));

		expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Scroll to bottom" }),
		).toBeNull();
	});

	it("drops the at-bottom flag so a jump is not scrolled away", () => {
		const ref = createRef<MessageListHandle>();
		const messages: Message[] = [
			permissionMessage("m0", "p1"),
			...Array.from({ length: 80 }, (_, i) => textMessage(`m${i + 1}`)),
		];
		render(<MessageList ref={ref} sessionId="session-1" messages={messages} />);

		act(() => ref.current?.jumpToRequest("p1"));

		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
		expect(permissionCard("p1")).toHaveClass("jump-highlight");
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
			sessionId: "session-1",
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

	it("holds the view still when the page is merged into the message it lands above", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		// The reader is looking at the second row, with the first one just above
		// the top edge.
		scroller.scrollTop = ROW_HEIGHT;

		triggerHistorySentinel();

		// The page's last message and this transcript's first one are two halves of
		// one turn, so they are spliced into one bubble that keeps the first one's
		// id: the list is the same length, and the row grows by the two rows'
		// worth of older content now inside it.
		layoutRows((id) => (id === "m1" ? 3 * ROW_HEIGHT : ROW_HEIGHT));
		viewport.contentHeight = 1400;
		rerender(
			<MessageList {...props} messages={loaded} loadedHistoryPages={1} />,
		);

		// Pinned to the row that grew, the view would not move at all and the whole
		// transcript would drop two rows down the screen.
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);
	});

	it("restores to where the reader left the view, not to where they asked from", () => {
		const { scroller, rerender, props } = renderPaging();
		scroller.scrollTop = 5 * ROW_HEIGHT;

		triggerHistorySentinel();
		// The flick that brought the sentinel into view carries on afterwards, and
		// the page is still in flight. Where it comes to rest is where the page has
		// to land the reader.
		dragTo(scroller, 2 * ROW_HEIGHT);

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);

		expect(scroller.scrollTop).toBe(4 * ROW_HEIGHT);
	});

	it("counts growth above the pin once when it lands between the request and a scroll", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;

		triggerHistorySentinel();

		// A late event — a tool result that belongs to a turn already on screen —
		// grows the first message while the page is still in flight. `overflow-
		// anchor: none` means the view does not follow it, so the reader's content
		// has moved down the screen under them.
		layoutRows((id) => (id === "m1" ? 3 * ROW_HEIGHT : ROW_HEIGHT));
		viewport.contentHeight = 1200;
		// They then scroll, so the offset the pin remembers is read after that
		// growth. Pairing it with the row position read before would charge the
		// restore for the same 200px twice.
		dragTo(scroller, 350);

		layoutRows((id) => (id === "m1" ? 3 * ROW_HEIGHT : ROW_HEIGHT));
		viewport.contentHeight = 1400;
		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);

		// Two rows landed above the pin, and only those two rows may move the view.
		expect(scroller.scrollTop).toBe(350 + 2 * ROW_HEIGHT);
	});

	it("refuses a page while the one that landed is still settling", () => {
		vi.useFakeTimers();
		const { scroller, rerender, props, onLoadMoreHistory } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;
		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);

		// The page is still settling, and each correction can carry the sentinel
		// back over the top edge. A crossing the corrections caused is not a page
		// the reader asked for — and one such crossing per correction is the
		// stutter this gate exists to stop.
		triggerHistorySentinel();
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);

		act(() => vi.advanceTimersByTime(SETTLED));
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(2);
	});

	it("drops a page in flight when paging starts over rather than restoring against it", () => {
		vi.useFakeTimers();
		const { scroller, rerender, props } = renderPaging();
		scroller.scrollTop = ROW_HEIGHT;
		triggerHistorySentinel();

		// One page lands, and the next is asked for once its restore settles.
		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		act(() => vi.advanceTimersByTime(SETTLED));
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);

		// That page never arrives: the connection drops and re-subscribing lands
		// back on the newest page, which starts the page count over. Rows the pin
		// knows are in there, at offsets it was never measured against — restoring
		// would move the reader for a page that was dropped, not delivered.
		rerender(
			<MessageList
				{...props}
				messages={pagedIn.slice(1)}
				loadedHistoryPages={0}
			/>,
		);

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
		// The anchored row started at the top edge of the view (it sat one row
		// down, and so did the view), and taller rows have to leave it there.
		expect(scroller.scrollTop).toBe(3 * 2 * ROW_HEIGHT);

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

		// One arming buys one request. The corrections a settling page makes carry
		// the sentinel back over the top edge, and a report of such a crossing can
		// be delivered after the stall is set — with nothing left watching, it
		// cannot buy a page the stall just refused.
		triggerHistorySentinel();
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);

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
				messages={[textMessage("older1"), textMessage("older2"), loaded[0]]}
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
				sessionId="session-1"
				messages={[textMessage("m1")]}
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
			<MessageList sessionId="session-1" messages={[textMessage("m1")]} />,
		);
		expect(screen.queryByText("Beginning of conversation")).toBeNull();

		rerender(
			<MessageList
				sessionId="session-1"
				messages={[textMessage("m1")]}
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

	// The answer panel sits on the bottom edge of this rectangle and says how
	// tall it is. The padding alone would leave the tail exactly that far below
	// the fold — `scrollTop` does not move when padding is added — so the frame
	// the panel appears in would cover the newest message and stop following.
	it("holds the tail above whatever covers the bottom of the rectangle", () => {
		const { scroller, viewport, rerender } = renderFollowing();

		// A real scroller counts its bottom padding in `scrollHeight`; jsdom has
		// to be told, so the stub grows by the inset the rerender below adds.
		viewport.contentHeight = 1300;
		rerender(
			<MessageList
				sessionId="session-1"
				messages={transcript}
				bottomInset={300}
			/>,
		);

		expect(scroller.style.paddingBottom).toBe("300px");
		expect(scroller.scrollTop).toBe(1300);
		expect(
			screen.queryByRole("button", { name: "Scroll to bottom" }),
		).toBeNull();
	});

	// The reader who has scrolled away keeps their place: the inset is not a
	// reason to drag them back to the tail.
	it("leaves a view that is not at the tail where it is", () => {
		const { scroller, viewport, rerender } = renderFollowing();
		dragTo(scroller, 200);

		// As above: the padding the inset adds is part of `scrollHeight`.
		viewport.contentHeight = 1300;
		rerender(
			<MessageList
				sessionId="session-1"
				messages={transcript}
				bottomInset={300}
			/>,
		);

		expect(scroller.scrollTop).toBe(200);
		// And the way back to the tail is lifted clear of what covers it, or it
		// would be the one control the panel hides.
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toHaveStyle({ bottom: "316px" });
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

	// Sending is an explicit return to the tail — the reader just wrote at the
	// bottom — and the two things that arrive as `role: "user"` without anybody
	// typing must not be mistaken for that. An agent's answer to a posted
	// question is the second of them, and it can arrive at any moment while the
	// reader is deliberately somewhere else in the transcript.
	it.each([
		["typed by the user", userMessage("sent")],
		[
			"an answer another agent gave",
			{
				...userMessage("answered"),
				source: "agent" as const,
				answering: [
					{
						request_id: "r1",
						answers: ["Postgres"],
						answered_at: "2026-01-02T14:05:00Z",
						resolved_by: { kind: "agent" as const },
					},
				],
			},
		],
		[
			"one of Pockode's own",
			{
				...userMessage("kickoff"),
				source: "system" as const,
				subtype: "kickoff",
			},
		],
	])("follows the tail only for a message %s", (name, message) => {
		const { rerender, scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		rerender(
			<MessageList sessionId="session-1" messages={[...transcript, message]} />,
		);
		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));

		expect(scroller.scrollTop).toBe(name === "typed by the user" ? 1400 : 200);
	});

	it("does not resume following when a jump lands near the tail", () => {
		const ref = createRef<MessageListHandle>();
		render(
			<MessageList
				ref={ref}
				sessionId="session-1"
				messages={[...transcript, permissionMessage("q1", "p1")]}
			/>,
		);
		const scroller = scrollContainer();
		const viewport = stubViewport(scroller, {
			contentHeight: 1000,
			viewportHeight: 500,
		});
		dragTo(scroller, 200);

		act(() => ref.current?.jumpToRequest("p1"));

		// The jump is aimed at a card close to the end of the transcript, so
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
			sessionId: "session-1",
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
				sessionId="session-1"
				messages={[...transcript, userMessage("sent")]}
			/>,
		);

		expect(scroller.scrollTop).toBe(1000);
	});
});
