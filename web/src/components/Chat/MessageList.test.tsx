import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	maxScrollTop,
	type ScrollBox,
	stubScrollBox,
} from "../../test/scrollBox";
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

/**
 * The reader scrolls. The list hears about it only through the scroll event the
 * browser dispatches afterwards: there is nothing listening for the gesture
 * itself any more, because a gesture says nothing about where it ends up.
 */
function dragTo(el: HTMLElement, scrollTop: number) {
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

interface Layout {
	/**
	 * The heights of the top-level parts of a row, by message id. A row is as
	 * tall as its parts, so the two can never disagree — a test cannot ask for a
	 * hold the container itself makes impossible.
	 */
	partHeights?: (messageId: string) => number[];
	/** Where the first row starts; see `bottomAlignRows`. */
	top?: () => number;
}

/**
 * Lays the transcript out. jsdom lays nothing out, and an element's position in
 * the list is the whole of what an anchor is made of — both the rows and the
 * parts inside them, since a part is what the view is held over once the reader
 * is somewhere in the middle of a long turn.
 */
function layout({ partHeights = () => [ROW_HEIGHT], top = () => 0 }: Layout) {
	const rowHeight = (messageId: string) =>
		partHeights(messageId).reduce((total, height) => total + height, 0);
	Object.defineProperty(HTMLElement.prototype, "offsetTop", {
		configurable: true,
		get(this: HTMLElement) {
			const row = this.closest<HTMLElement>("[data-message-id]");
			if (!row) return 0;
			let offset = top();
			for (const other of document.querySelectorAll<HTMLElement>(
				"[data-message-id]",
			)) {
				if (other === row) break;
				offset += rowHeight(other.dataset.messageId ?? "");
			}
			if (this === row) return offset;
			const heights = partHeights(row.dataset.messageId ?? "");
			for (const [index, part] of [
				...row.querySelectorAll<HTMLElement>("[data-scroll-anchor]"),
			].entries()) {
				if (part === this) break;
				offset += heights[index] ?? 0;
			}
			return offset;
		},
	});
}

/**
 * Lays the rows out at `factor` times their normal height — how a page that
 * finishes rendering after it landed is expressed.
 */
function stretchRows(factor: number) {
	layout({ partHeights: () => [ROW_HEIGHT * factor] });
}

/**
 * Lays the rows out from a height per row, for the cases where they are not all
 * the same: a page merged into the message it landed above grows that one row
 * and no other.
 */
function layoutRows(height: (messageId: string) => number) {
	layout({ partHeights: (messageId) => [height(messageId)] });
}

/**
 * Lays the rows on the bottom edge of the viewport, which is where `justify-end`
 * holds them while the transcript is shorter than it. A page landing above then
 * fills space that was empty and leaves every row already on screen exactly
 * where it was — the state where nothing about the view can say whether the top
 * of history is still on screen.
 */
function bottomAlignRows(viewportHeight: number) {
	layout({
		top: () =>
			viewportHeight -
			document.querySelectorAll("[data-message-id]").length * ROW_HEIGHT,
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

/**
 * Renders a transcript in a container whose two heights a test can move. The
 * resize is the container learning its size, which is what pins the view to the
 * end: until that has happened there is no end to have left.
 */
function renderScrolling(
	messages: Message[],
	{
		box = { contentHeight: 1000, viewportHeight: 500 },
		ref,
	}: {
		box?: ScrollBox;
		/** For the tests that jump through the handle the attention strip uses. */
		ref?: RefObject<MessageListHandle | null>;
	} = {},
) {
	const view = render(
		<MessageList ref={ref} sessionId="session-1" messages={messages} />,
	);
	const scroller = scrollContainer();
	const viewport = stubScrollBox(scroller, box);
	triggerResize(scroller);
	return { ...view, scroller, viewport };
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

	// A row's position in the list is the other half of what the scroll anchor is
	// made of; the offsets themselves are remembered and clamped by the shared
	// setup.
	stretchRows(1);
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
		const { scroller, viewport } = renderScrolling(
			[questionMessage("m1", "r1")],
			{ ref },
		);

		act(() => ref.current?.jumpToRequest("r1"));

		// Neither the view nor the state may move on the strength of an id that
		// places nothing.
		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));
		expect(
			screen.queryByRole("button", { name: "Scroll to bottom" }),
		).toBeNull();
	});

	it("takes the view to the card and reads from there", () => {
		const ref = createRef<MessageListHandle>();
		const before = Array.from({ length: 40 }, (_, i) => textMessage(`m${i}`));
		const after = Array.from({ length: 40 }, (_, i) => textMessage(`n${i}`));
		const { scroller } = renderScrolling(
			[...before, permissionMessage("card", "p1"), ...after],
			{ box: { contentHeight: 8100, viewportHeight: 500 }, ref },
		);

		act(() => ref.current?.jumpToRequest("p1"));

		// The card sits at the top of the view, and the transcript is being read
		// from there: the output still landing at the end must not push it away, and
		// the way back to the end is the button.
		expect(scroller.scrollTop).toBe(before.length * ROW_HEIGHT);
		expect(permissionCard("p1")).toHaveClass("jump-highlight");
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
	});
});

describe("MessageList history paging", () => {
	const loaded = [textMessage("m1"), textMessage("m2")];
	const pagedIn = [textMessage("older1"), textMessage("older2"), ...loaded];

	function renderPaging() {
		/** Pages actually requested. */
		const pages = vi.fn();
		/** Every call the list makes, including the ones refused below. */
		const calls = vi.fn();
		// Stands in for `useChatMessages.loadMoreHistory`, which refuses a request
		// while one is in flight — synchronously, before any render. Asking is
		// therefore idempotent, and the list asks on two triggers that legitimately
		// coincide: the observer reporting the sentinel, and the commit that measured
		// it. A plain spy would count that as two pages.
		let inFlight = false;
		const onLoadMoreHistory = () => {
			calls();
			if (inFlight) return;
			inFlight = true;
			pages();
		};
		const props = {
			sessionId: "session-1",
			hasMoreHistory: true,
			onLoadMoreHistory,
		};
		const { rerender } = render(
			<MessageList {...props} messages={loaded} loadedHistoryPages={0} />,
		);
		const scroller = scrollContainer();
		// More content than the view holds, so there is something for a page to
		// push the view over. The case where there is not is its own test.
		const viewport = stubScrollBox(scroller, {
			contentHeight: 1000,
			viewportHeight: 500,
		});
		// The container learning its size is what pins the tail. Until then there is
		// nothing to be at the end of, so a drag away from the end would not read as
		// one — which is what tells the list the reader has left the tail.
		triggerResize(scroller);

		/**
		 * The page arrives: nothing is in flight any more, and the rows go in.
		 * `rest` is how the answer that came with it is passed on — the server
		 * saying there is nothing older, or the request having failed.
		 */
		function land(
			messages: Message[],
			loadedHistoryPages: number,
			rest: { hasMoreHistory?: boolean; historyError?: string } = {},
		) {
			inFlight = false;
			rerender(
				<MessageList
					{...props}
					messages={messages}
					loadedHistoryPages={loadedHistoryPages}
					{...rest}
				/>,
			);
		}

		return { pages, calls, props, rerender, land, scroller, viewport };
	}

	it("asks for nothing on the frame it mounts in, before the container has a size", () => {
		const onLoadMoreHistory = vi.fn();
		render(
			<MessageList
				sessionId="session-1"
				messages={loaded}
				hasMoreHistory
				onLoadMoreHistory={onLoadMoreHistory}
			/>,
		);

		// A container with no height shows nothing, so nothing is on screen. Reading
		// "the top of history is in view" out of that is how a transcript asks for a
		// page before the reader has been shown a single line of the one it has.
		expect(scrollContainer().clientHeight).toBe(0);
		expect(onLoadMoreHistory).not.toHaveBeenCalled();
	});

	it("asks for an earlier page when the top of the loaded history comes into view", () => {
		const { pages } = renderPaging();

		triggerHistorySentinel();
		expect(pages).toHaveBeenCalledTimes(1);
	});

	it("holds the view over the messages already on screen when a page lands above them", () => {
		const { scroller, rerender, props } = renderPaging();
		// Reading back up is what takes the list off the tail: the state changes on
		// the reader's own scrolling and on nothing else.
		dragTo(scroller, ROW_HEIGHT);

		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);

		// Two rows went in above the anchor, so the view has to move down by
		// exactly two rows to leave it where it was on screen.
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);
	});

	it("holds the view still when the page is merged into the message it lands above", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		// The reader is looking at the second row, with the first one just above
		// the top edge.
		dragTo(scroller, ROW_HEIGHT);

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

		// Anchored to the row that grew, the view would not move at all and the
		// whole transcript would drop two rows down the screen — which is why
		// neither the first row nor its first part is ever the anchor.
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);
	});

	it("restores to where the reader left the view, not to where they asked from", () => {
		const { scroller, rerender, props } = renderPaging();

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

	it("counts growth above the anchor once when it lands between the request and a scroll", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		dragTo(scroller, ROW_HEIGHT);

		triggerHistorySentinel();

		// A late event — a tool result that belongs to a turn already on screen —
		// grows the first message while the page is still in flight. `overflow-
		// anchor: none` means the view does not follow it, so the reader's content
		// has moved down the screen under them.
		layoutRows((id) => (id === "m1" ? 3 * ROW_HEIGHT : ROW_HEIGHT));
		viewport.contentHeight = 1200;
		// They then scroll, which takes the anchor again — element and offset
		// together. Pairing a fresh offset with a position read before that growth
		// would charge the restore for the same 200px twice.
		dragTo(scroller, 350);

		layoutRows((id) => (id === "m1" ? 3 * ROW_HEIGHT : ROW_HEIGHT));
		viewport.contentHeight = 1400;
		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);

		// Two rows landed above the anchor, and only those two rows may move the
		// view.
		expect(scroller.scrollTop).toBe(350 + 2 * ROW_HEIGHT);
	});

	it("does not even ask while the prop says a page is in flight", () => {
		const { rerender, props, calls } = renderPaging();

		triggerHistorySentinel();
		expect(calls).toHaveBeenCalledTimes(1);

		// The observer goes on watching the sentinel, which is still on screen. The
		// request that is out would refuse a second one anyway — this is the list not
		// making it.
		rerender(
			<MessageList
				{...props}
				messages={loaded}
				isLoadingMoreHistory
				loadedHistoryPages={0}
			/>,
		);
		triggerHistorySentinel();
		expect(calls).toHaveBeenCalledTimes(1);
	});

	it("reads the tail again when a reconnect replaces the transcript", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		dragTo(scroller, ROW_HEIGHT);
		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);

		// The connection drops, and re-subscribing lands back on the newest page:
		// the transcript is replaced and the page count starts over. An anchor names
		// a row in there at an offset it was never measured against, and the newest
		// page is what was just asked for.
		rerender(
			<MessageList
				{...props}
				messages={pagedIn.slice(1)}
				loadedHistoryPages={0}
			/>,
		);

		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));
	});

	it("holds the anchor as the page that landed goes on rendering", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		dragTo(scroller, ROW_HEIGHT);
		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);

		// A diagram inside the page that just landed finishes rendering, and every
		// row above the anchor doubles in height. Nothing about that is a case of
		// its own: it is one more resize, and the anchor is held on the frame it
		// arrives in — there is no window after which it stops being held, so
		// nothing has to guess how long rendering takes.
		stretchRows(2);
		viewport.contentHeight = 2000;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(3 * 2 * ROW_HEIGHT);
	});

	it("stops asking once the page that landed pushed the top of history off the view", () => {
		const { scroller, land, pages } = renderPaging();
		dragTo(scroller, ROW_HEIGHT);
		triggerHistorySentinel();

		land(pagedIn, 1);

		// The page went in above the reader, so the top of history is off the top of
		// the view: they have what they asked for and nothing asks for more.
		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);
		expect(pages).toHaveBeenCalledTimes(1);
	});

	it("keeps filling a viewport the transcript does not reach the bottom of", () => {
		const { land, scroller, viewport, pages } = renderPaging();
		// Nothing to scroll: the content box is `min-h-full`, so a transcript this
		// short leaves the view pinned at 0 however well the page lands, and the
		// rows it holds on the bottom edge do not move either. An observer reports
		// crossings and there is no crossing to report, so what keeps this going is
		// the list measuring the sentinel itself, on the commit the page landed in.
		viewport.contentHeight = 500;
		bottomAlignRows(viewport.viewportHeight);
		triggerHistorySentinel();

		land(pagedIn, 1);
		expect(scroller.scrollTop).toBe(0);
		expect(pages).toHaveBeenCalledTimes(2);
	});

	// The whole of "a short conversation fills up and then stops". Paging on a
	// state has to be shown to settle, and to settle on the right number: one
	// request per page and not one more, with the reader untouched throughout.
	it("fills the top page after page and stops at the start of the conversation", () => {
		const { land, scroller, viewport, pages, calls } = renderPaging();
		// Shorter than the view, so nothing the paging does can move the view or the
		// rows: `min-h-full` holds them on the bottom edge and a page fills space
		// that was empty above them. No crossing ever happens — and the observer is
		// never rebuilt either, so it reports once and then has nothing to say. What
		// carries this is the list measuring the sentinel on each commit.
		viewport.contentHeight = 500;
		bottomAlignRows(viewport.viewportHeight);

		/** The rows a page at a time brings in, oldest first. */
		const older = (pageCount: number) =>
			[...Array(pageCount).keys()].map((i) =>
				textMessage(`older${pageCount - i}`),
			);
		/**
		 * Where the row the reader is looking at sits on the screen. Every page goes
		 * in above it, so this is the number that must not move: the reader asked for
		 * history, not to be taken somewhere else.
		 */
		const readerRowOnScreen = () => {
			const row = document.querySelector<HTMLElement>('[data-message-id="m2"]');
			if (!row) throw new Error("the row the reader is on left the transcript");
			return row.offsetTop - scroller.scrollTop;
		};
		const startedAt = readerRowOnScreen();

		triggerHistorySentinel();
		expect(pages).toHaveBeenCalledTimes(1);

		// One message per page, and three pages before the server runs out: enough
		// that neither trigger can have carried it on its own, which two pages could
		// not have shown.
		land([...older(1), ...loaded], 1);
		expect(pages).toHaveBeenCalledTimes(2);
		expect(readerRowOnScreen()).toBe(startedAt);

		land([...older(2), ...loaded], 2);
		expect(pages).toHaveBeenCalledTimes(3);
		expect(readerRowOnScreen()).toBe(startedAt);

		// The last page, and the server says so with it.
		land([...older(3), ...loaded], 3, { hasMoreHistory: false });
		expect(screen.getByText("Beginning of conversation")).toBeInTheDocument();
		expect(readerRowOnScreen()).toBe(startedAt);

		// Three pages arrived, three were asked for, and nothing was asked for that
		// was refused: the list stopped on the answer rather than on a request it
		// then had to take back. Commits go on arriving afterwards — every one of
		// them measures the sentinel — and none of them asks.
		land([...older(3), ...loaded], 3, { hasMoreHistory: false });
		expect(pages).toHaveBeenCalledTimes(3);
		expect(calls).toHaveBeenCalledTimes(3);
	});

	it("stops asking when a page fails, and asks again once the error clears", () => {
		const { land, viewport, pages } = renderPaging();
		// The short transcript again: the top of history stays on screen whatever
		// happens, so nothing about the view is going to stop this on its own.
		viewport.contentHeight = 500;
		bottomAlignRows(viewport.viewportHeight);

		triggerHistorySentinel();
		expect(pages).toHaveBeenCalledTimes(1);

		// The request failed. Commits go on arriving — output lands, a card opens —
		// and every one of them would ask again if the error did not stand in the
		// way, which is a retry loop nobody asked for and nobody can see.
		const failed = { historyError: "Failed to load earlier messages: gone" };
		land(loaded, 0, failed);
		expect(screen.getByRole("alert")).toHaveTextContent("gone");
		land(loaded, 0, failed);
		expect(pages).toHaveBeenCalledTimes(1);

		// The error is the only thing that was refusing: once it clears — the retry
		// below, or a reconnect — the same state that asked the first time asks
		// again, without anything having to remember that it once failed.
		land(loaded, 0);
		expect(pages).toHaveBeenCalledTimes(2);
	});

	it("asks again when the page that landed rendered to nothing", () => {
		const { scroller, land, pages } = renderPaging();
		// Read right up to the top, which is where paging used to run away.
		dragTo(scroller, 0);
		triggerHistorySentinel();
		expect(pages).toHaveBeenCalledTimes(1);

		// A page whose records render to nothing: the cursor moved on, the
		// transcript did not, and the top of history is still on screen. Asking
		// again is what gets the reader past it, and it is bounded without a gate of
		// its own — every request moves the cursor further back and history is
		// finite.
		land(loaded, 1);
		expect(pages).toHaveBeenCalledTimes(2);
	});

	it("lets a jump back to the tail take the view over from the anchor", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		dragTo(scroller, 0);
		triggerHistorySentinel();

		rerender(
			<MessageList {...props} messages={pagedIn} loadedHistoryPages={1} />,
		);
		expect(scroller.scrollTop).toBe(2 * ROW_HEIGHT);

		fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));

		// The page that landed finishes rendering. Holding the anchor now would undo
		// the jump the reader just asked for.
		stretchRows(2);
		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));
	});

	it("stops cleanly once the server says there is nothing older", () => {
		const { rerender, props, scroller, pages } = renderPaging();
		dragTo(scroller, ROW_HEIGHT);
		triggerHistorySentinel();

		// The last page, and with it the sentinel: nothing is left to observe or to
		// measure, so nothing can ask again.
		rerender(
			<MessageList
				{...props}
				hasMoreHistory={false}
				messages={pagedIn}
				loadedHistoryPages={1}
			/>,
		);

		expect(pages).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Beginning of conversation")).toBeInTheDocument();
	});

	it("does not read the tail again because the page landed under a sent message", () => {
		const { scroller, rerender, props } = renderPaging();
		const sent = [...loaded, userMessage("sent")];
		rerender(<MessageList {...props} messages={sent} loadedHistoryPages={0} />);
		dragTo(scroller, ROW_HEIGHT);
		triggerHistorySentinel();

		// The newest row is one the reader typed, and it is still the newest row
		// after the page lands: a prepend adds nothing at the end, so nothing about
		// it says they want to be back there.
		rerender(
			<MessageList
				{...props}
				messages={[textMessage("older1"), textMessage("older2"), ...sent]}
				loadedHistoryPages={1}
			/>,
		);

		expect(scroller.scrollTop).toBe(3 * ROW_HEIGHT);
	});

	it("keeps the reader where they are when the anchored element is gone", () => {
		const { scroller, rerender, props, viewport } = renderPaging();
		dragTo(scroller, ROW_HEIGHT);
		triggerHistorySentinel();

		// The page landed, but the row the anchor named is not in the list any more.
		// A fresh anchor for where the view is now is the answer; going back to the
		// tail would take the reader off the history they asked for.
		viewport.contentHeight = 1400;
		rerender(
			<MessageList
				{...props}
				messages={[textMessage("older1"), textMessage("older2"), loaded[0]]}
				loadedHistoryPages={1}
			/>,
		);

		expect(scroller.scrollTop).toBe(ROW_HEIGHT);
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

	// Twice the viewport of content, which is where a transcript opens: pinned to
	// the end, with as much again above it.
	function renderFollowing() {
		return renderScrolling(transcript);
	}

	it("leaves the view where the user scrolled it while the content keeps growing", () => {
		const { scroller, viewport } = renderFollowing();

		dragTo(scroller, 200);

		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));

		expect(scroller.scrollTop).toBe(200);
	});

	// Root cause 1 of the scroll rework: where the view happens to sit is read as
	// where the reader wants to be. A scroll event reaches this list a frame after
	// the scrolling it reports, and by then the content has grown again — so the
	// sample says "not at the bottom" about a frame nobody scrolled in.
	//
	// The tap is what makes it stick. It scrolls nothing, but it arms the flag
	// that says the scrolling now in progress is the user's, and that flag
	// outlives the gesture; the next late sample is therefore taken as the reader
	// choosing to leave the tail, and nothing but a scroll back to the bottom
	// brings following back. Deterministic: two frames of output after one tap.
	//
	// Red on purpose until the two-state rework lands: today's control model
	// cannot keep this promise, and the promise is what the rework is for.
	it("keeps following after a tap while output lands two frames running", () => {
		const { scroller, viewport } = renderFollowing();

		// A tap on a card — expanding a tool row, opening a diff. No scroll event
		// follows it, because nothing moved.
		fireEvent.pointerDown(scroller);

		// Frame 1: output lands, and the tail is followed to the bottom of the
		// content as it stands this frame.
		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));

		// Frame 2: more output lands before the scroll event frame 1 caused has
		// been delivered. The view really is 400px above the bottom when that
		// event arrives — every frame of following looks like this — and it says
		// nothing about what the reader wants.
		viewport.contentHeight = 1800;
		fireEvent.scroll(scroller);
		triggerResize(contentBox(scroller));

		expect(
			scroller.scrollTop,
			"following was dropped by a scroll event nobody caused: after a tap and two frames of output the view stopped moving with the tail",
		).toBe(maxScrollTop(viewport));
	});

	it("follows again once the user scrolls back to the bottom", () => {
		const { scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		dragTo(scroller, 500);

		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));
	});

	it("pins the tail again when the viewport shrinks under it", () => {
		const { scroller, viewport } = renderFollowing();

		// The software keyboard opens, or the input box grows a line: the content
		// is untouched, only the container it is read through gets shorter.
		viewport.viewportHeight = 250;
		triggerResize(scroller);

		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));
	});

	it("hands the endpoint back to the tail rather than to one frame's bottom", async () => {
		const { scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		await userEvent.click(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		);
		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));

		// Syntax highlighting lands and the bottom moves past the offset the button
		// aimed at. Reading the tail is a state, not a destination, so the view goes
		// to the new bottom rather than staying at the one that was current when the
		// button was pressed.
		viewport.contentHeight = 1500;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));
	});

	// Root cause 2 of the scroll rework: while the reader is somewhere in the
	// middle of a long turn, anything above their eyes that finishes rendering
	// later used to push what they were reading down the screen — the anchor only
	// existed for the 500ms after a page landed, and only ever named a whole row.
	it("holds the part the reader is on when an earlier part of the same row grows", () => {
		const twoParts: Message = {
			id: "m1",
			role: "assistant",
			status: "complete",
			createdAt: new Date(),
			parts: [
				{ type: "text", content: "the part above" },
				{ type: "text", content: "the part being read" },
			],
		};
		const { scroller, viewport } = renderScrolling([
			textMessage("m0"),
			twoParts,
			textMessage("m2"),
		]);
		// m0 takes the first row, m1's two parts the next two, m2 the last: the
		// reader is on m1's second part, with its first part just above the edge.
		layout({ partHeights: (id) => (id === "m1" ? [100, 100] : [100]) });
		dragTo(scroller, 200);

		// A code block inside the part above finishes highlighting, so everything
		// under it moves 150px down the content.
		layout({ partHeights: (id) => (id === "m1" ? [250, 100] : [100]) });
		viewport.contentHeight = 1150;
		triggerResize(contentBox(scroller));

		// Anchored to the row, the view would have stayed at 200 and the reader
		// would be looking at the part above instead.
		expect(scroller.scrollTop).toBe(350);
	});

	// The other half of requiring a *direction*: reaching the end is only a return
	// to the tail when the reader moved there.
	it("stays where it is when content collapsing below clamps the view", () => {
		const { scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		// A tool result below the view is collapsed, and the content is suddenly
		// shorter than the offset the view sits at: the browser clamps the view up,
		// which lands it at the end without anyone having scrolled there. Writing the
		// clamped offset back is the scroll event the clamp itself causes — the one
		// thing that could be mistaken for the reader arriving at the end.
		viewport.contentHeight = 600;
		triggerResize(contentBox(scroller));
		dragTo(scroller, scroller.scrollTop);
		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));

		// Read as a return to the tail, the next output would drag the reader to the
		// bottom of the conversation.
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
		viewport.contentHeight = 1000;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(100);
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

		expect(scroller.scrollTop).toBe(
			name === "typed by the user" ? maxScrollTop(viewport) : 200,
		);
	});

	it("leaves the card a jump landed on where it is while output goes on landing", () => {
		const ref = createRef<MessageListHandle>();
		render(
			<MessageList
				ref={ref}
				sessionId="session-1"
				messages={[...transcript, permissionMessage("q1", "p1")]}
			/>,
		);
		const scroller = scrollContainer();
		const viewport = stubScrollBox(scroller, {
			contentHeight: 1200,
			viewportHeight: 500,
		});
		triggerResize(scroller);

		act(() => ref.current?.jumpToRequest("p1"));
		// The card is the sixth row, and the jump puts it against the top edge.
		expect(scroller.scrollTop).toBe(5 * ROW_HEIGHT);

		// The agent is still writing while the reader looks at the card it is
		// waiting on. Following the tail here would drag the card they were sent to
		// straight back off the screen.
		viewport.contentHeight = 1600;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(5 * ROW_HEIGHT);
	});

	it("leaves a freshly paged-in view where the page landed it", () => {
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
		const viewport = stubScrollBox(scroller, {
			contentHeight: 1000,
			viewportHeight: 500,
		});
		triggerResize(scroller);

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
		const { rerender, scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		rerender(
			<MessageList
				sessionId="session-1"
				messages={[...transcript, userMessage("sent")]}
			/>,
		);

		expect(scroller.scrollTop).toBe(maxScrollTop(viewport));
	});
});
