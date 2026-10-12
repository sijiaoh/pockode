import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type RefObject, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollBox } from "../../test/scrollBox";
import type { ContentPart, Message } from "../../types/message";
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
	/** Targets a test has put in range; see `observe`. */
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
		// it starts watching it — which is why the list builds one observer per
		// reserve and never rebuilds it per page: rebuilt, it would ask again for
		// every page that left the reserve where it was.
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
 * The box holding the messages. Which of the two resizes is the whole point of
 * several tests below: the content grows as output streams in, the container
 * shrinks under the software keyboard.
 */
function contentBox(scroller: HTMLElement): HTMLElement {
	const el = scroller.querySelector("[data-message-id]")?.parentElement;
	if (!el) throw new Error("no content box");
	return el;
}

/**
 * The transcript's two heights, as `stubTranscript` was given them: the rows'
 * box (`contentHeight`) and the view. Null in a test that gave none, where
 * nothing is laid out at all.
 */
let transcriptBox: ScrollBox | null = null;

/**
 * How tall the track is: what the list last wrote on it, never less than the
 * view — `min-h-full` until the first write.
 */
function trackHeight(): number {
	const track = scrollContainer().firstElementChild as HTMLElement;
	const written = Number.parseFloat(track.style.height) || 0;
	return Math.max(written, transcriptBox?.viewportHeight ?? 0);
}

/**
 * Where the rows' box starts in the track: on its bottom edge, so above the
 * track's top — out of reach — when the rows are the taller.
 */
function rowsTop(): number {
	return transcriptBox ? trackHeight() - transcriptBox.contentHeight : 0;
}

/**
 * Gives the scroller its view's height and the rows their box's, both live.
 * Unlike a plain scroll box, how far the content scrolls is not one of them:
 * that is the track, whose height the list writes — the rows growing changes
 * it only if the list says so.
 */
function stubTranscript(scroller: HTMLElement, box: ScrollBox): ScrollBox {
	transcriptBox = box;
	Object.defineProperty(scroller, "scrollHeight", {
		configurable: true,
		get: trackHeight,
	});
	Object.defineProperty(scroller, "clientHeight", {
		configurable: true,
		get: () => box.viewportHeight,
	});
	return box;
}

/** How tall a row is laid out, as `layout` was last told. */
let layoutRowHeight: (messageId: string) => number = () => ROW_HEIGHT;

/**
 * The rows' box as tall as the rows in it, as it really is — plus `below`, for
 * output at the end that no row here stands for — however the rows change.
 */
function fitRows(box: ScrollBox, below = 0) {
	Object.defineProperty(box, "contentHeight", {
		configurable: true,
		get: () =>
			[...document.querySelectorAll<HTMLElement>("[data-message-id]")].reduce(
				(total, row) => total + layoutRowHeight(row.dataset.messageId ?? ""),
				below,
			),
	});
}

function maxScrollTop(scroller: HTMLElement): number {
	return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

/** How far below the view's top edge a row sits — what the reader sees move. */
function onScreen(messageId: string): number {
	const row = document.querySelector<HTMLElement>(
		`[data-message-id="${messageId}"]`,
	);
	if (!row) throw new Error(`no row ${messageId}`);
	return row.getBoundingClientRect().top;
}

/** The reader scrolls so that `messageId`'s row starts `offset` above the view. */
function dragRowTo(scroller: HTMLElement, messageId: string, offset = 0) {
	dragTo(scroller, scroller.scrollTop + onScreen(messageId) + offset);
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
}

/**
 * Lays the transcript out. jsdom lays nothing out, and an element's position in
 * the list is the whole of what an anchor is made of — both the rows and the
 * parts inside them, since a part is what the view is held over once the reader
 * is somewhere in the middle of a long turn. Anything inside a part sits at the
 * part's top with no height of its own, so the finer levels of the anchor's path
 * move exactly with the part they are in.
 */
function layout({ partHeights = () => [ROW_HEIGHT] }: Layout) {
	const rowHeight = (messageId: string) =>
		partHeights(messageId).reduce((total, height) => total + height, 0);
	layoutRowHeight = rowHeight;
	const partsOf = (row: HTMLElement) =>
		[...row.querySelectorAll<HTMLElement>("[data-scroll-anchor]")].filter(
			(part) => part.parentElement?.closest("[data-scroll-anchor]") === row,
		);
	/**
	 * Where `el` sits in the transcript and how tall it is, if it is the rows'
	 * box, the reserve over it, or in a row.
	 */
	const place = (el: HTMLElement) => {
		if (el.dataset.testid === "history-reserve") {
			// Whatever the track leaves over the rows, and nothing at all — at the
			// rows' top edge — once they are taller than the track.
			return { offset: Math.min(0, rowsTop()), height: Math.max(0, rowsTop()) };
		}
		if (transcriptBox && el.querySelector(":scope > [data-message-id]")) {
			return { offset: rowsTop(), height: transcriptBox.contentHeight };
		}
		const row = el.closest<HTMLElement>("[data-message-id]");
		if (!row) return null;
		const messageId = row.dataset.messageId ?? "";
		let offset = rowsTop();
		for (const other of document.querySelectorAll<HTMLElement>(
			"[data-message-id]",
		)) {
			if (other === row) break;
			offset += rowHeight(other.dataset.messageId ?? "");
		}
		if (el === row) return { offset, height: rowHeight(messageId) };
		const heights = partHeights(messageId);
		for (const [index, part] of partsOf(row).entries()) {
			if (part.contains(el)) {
				return { offset, height: part === el ? (heights[index] ?? 0) : 0 };
			}
			offset += heights[index] ?? 0;
		}
		return { offset, height: 0 };
	};
	const native = Element.prototype.getBoundingClientRect;
	// What a browser reports for an element that is not displayed: no boxes at
	// all, and a rectangle of zeros.
	Object.defineProperty(HTMLElement.prototype, "getClientRects", {
		configurable: true,
		value(this: HTMLElement) {
			return this.closest("[hidden]") ? [] : [this.getBoundingClientRect()];
		},
	});
	Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value(this: HTMLElement) {
			const at = this.closest("[hidden]") ? null : place(this);
			if (!at) return native.call(this);
			return DOMRect.fromRect({
				y: at.offset - scrollContainer().scrollTop,
				height: at.height,
			});
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

function scrollContainer(): HTMLElement {
	const el = document.querySelector<HTMLElement>(".overflow-y-auto");
	if (!el) throw new Error("no scroll container");
	return el;
}

/**
 * Reports the history reserve above the rows as in range — the top of the
 * loaded history within a screen of the view — as reading back up brings it. It
 * is the only node the list observes at all now, so nothing has to be told apart
 * from it. It stays in range until a test says otherwise, so that any observer
 * armed afterwards reports it the way a real one would.
 */
function revealReserve() {
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
				id: `question-${requestId}`,
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
		parts: [{ type: "text", id: `text-${id}`, content: `text ${id}` }],
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
	const viewport = stubTranscript(scroller, box);
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
				id: `card-${requestId}`,
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
	transcriptBox = null;
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
		const { scroller } = renderScrolling([questionMessage("m1", "r1")], {
			ref,
		});

		act(() => ref.current?.jumpToRequest("r1"));

		// Neither the view nor the state may move on the strength of an id that
		// places nothing.
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
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

// The landing itself is `useFoldLanding`'s to decide (ToolCallItem.test.tsx);
// what is held here is that the transcript carries it out through its own
// anchor, and only as far as the reader's state allows.
describe("folding an open tool row from its pinned bar", () => {
	const bash = (id: string): Message => ({
		id,
		role: "assistant",
		status: "complete",
		createdAt: new Date(),
		parts: [
			{
				type: "tool_call",
				id: `call-${id}`,
				tool: {
					id: `tool-${id}`,
					name: "Bash",
					input: { command: `run ${id}` },
					status: "success",
				},
			},
		],
	});

	/**
	 * Opens the call, then puts its row 50px above the view's top edge. Folding
	 * it can then shrink the content by `body`: a browser clamps the view to
	 * the new end as it lays the fold out, which moves the row down the view
	 * by as much as the view moved.
	 */
	async function openAbove(
		id: string,
		viewport: ScrollBox,
		scroller: HTMLElement,
	) {
		const user = userEvent.setup();
		const button = screen.getByRole("button", { name: new RegExp(id) });
		await user.click(button);
		const row = button.parentElement?.parentElement as HTMLElement;
		const opened = { top: -50, scrollTop: 0 };
		vi.spyOn(row, "getBoundingClientRect").mockImplementation(() =>
			DOMRect.fromRect({
				y: opened.top + opened.scrollTop - scroller.scrollTop,
				height: 100,
			}),
		);
		return {
			fold: async (body = 0) => {
				opened.scrollTop = scroller.scrollTop;
				viewport.contentHeight -= body;
				scroller.scrollTop = Math.min(
					scroller.scrollTop,
					maxScrollTop(scroller),
				);
				await user.click(button);
			},
		};
	}

	it("puts the row at the top of the view and reads from there", async () => {
		const before = Array.from({ length: 40 }, (_, i) => textMessage(`m${i}`));
		const after = Array.from({ length: 40 }, (_, i) => textMessage(`n${i}`));
		const { scroller, viewport } = renderScrolling(
			[...before, bash("fold-me"), ...after],
			{ box: { contentHeight: 8100, viewportHeight: 500 } },
		);
		dragTo(scroller, before.length * ROW_HEIGHT + 50);
		const { fold } = await openAbove("fold-me", viewport, scroller);

		await fold();
		expect(scroller.scrollTop).toBe(before.length * ROW_HEIGHT);

		// Held there as the anchor, not merely scrolled to: output landing at the
		// end does not move it, and the way back is the button.
		viewport.contentHeight = 9000;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(before.length * ROW_HEIGHT);
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
	});

	// The fold takes the body out of the content, so the end comes up to meet
	// the row: everything after it already fits in the view.
	it("goes on following the tail when the end shows the row's place", async () => {
		const before = Array.from({ length: 9 }, (_, i) => textMessage(`m${i}`));
		const { scroller, viewport } = renderScrolling([
			...before,
			bash("fold-me"),
		]);
		const { fold } = await openAbove("fold-me", viewport, scroller);

		await fold(100);
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));

		viewport.contentHeight = 1200;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
		expect(
			screen.queryByRole("button", { name: "Scroll to bottom" }),
		).toBeNull();
	});

	// Left at the end, the row would sit above the top, under the view's edge:
	// no landing at all.
	it("leaves the tail when the end would hide the row", async () => {
		const before = Array.from({ length: 9 }, (_, i) => textMessage(`m${i}`));
		const { scroller, viewport } = renderScrolling([
			...before,
			bash("fold-me"),
		]);
		const { fold } = await openAbove("fold-me", viewport, scroller);

		// A body of 20px: the clamp takes the view 20px up, which leaves the row
		// 30px above the edge at the end.
		await fold(20);
		expect(scroller.scrollTop).toBe(450);

		viewport.contentHeight = 1200;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(450);
	});
	// Folded with its title on screen, a two-line row's title rises a few
	// pixels, and holding it asks for a place above the top of a transcript
	// that does not scroll: still the end, not a reason to stop following.
	it("goes on following the tail when the title it holds is past the top", async () => {
		const { scroller, viewport } = renderScrolling(
			[textMessage("m0"), textMessage("m1"), bash("fold-me")],
			{ box: { contentHeight: 400, viewportHeight: 500 } },
		);
		const user = userEvent.setup();
		const button = screen.getByRole("button", { name: /fold-me/ });
		await user.click(button);
		const row = button.parentElement?.parentElement as HTMLElement;
		vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
			DOMRect.fromRect({ y: 200, height: 300 }),
		);
		const title = screen.getByText("Bash").parentElement as HTMLElement;
		vi.spyOn(title, "getBoundingClientRect")
			.mockReturnValueOnce(DOMRect.fromRect({ y: 214, height: 16 }))
			.mockReturnValue(DOMRect.fromRect({ y: 206, height: 16 }));

		await user.click(button);

		viewport.contentHeight = 1200;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
		expect(
			screen.queryByRole("button", { name: "Scroll to bottom" }),
		).toBeNull();
	});
});

describe("MessageList history paging", () => {
	const loaded = [textMessage("m1"), textMessage("m2")];
	const pagedIn = [textMessage("older1"), textMessage("older2"), ...loaded];

	function renderPaging({ below = 1000 }: { below?: number } = {}) {
		/** Pages actually requested. */
		const pages = vi.fn();
		/** Every call the list makes, including the ones refused below. */
		const calls = vi.fn();
		// Stands in for `useChatMessages.loadMoreHistory`, which refuses a request
		// while one is in flight — synchronously, before any render. Asking is
		// therefore idempotent, and the list asks on two triggers that legitimately
		// coincide: the observer reporting the reserve, and the commit that measured
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
		// The rows, and `below` more of output under them. With the default, the
		// top of the loaded history is more than a screen above the tail, so there
		// is something to scroll back up through before anything is asked for. The
		// case where there is not is its own test.
		const viewport = stubTranscript(scroller, {
			contentHeight: 0,
			viewportHeight: 500,
		});
		fitRows(viewport, below);
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

		// A container with no height shows nothing, so nothing is near. Reading
		// "the top of history is within a screen" out of that is how a transcript
		// asks for a page before the reader has been shown a single line of the
		// one it has.
		expect(scrollContainer().clientHeight).toBe(0);
		expect(onLoadMoreHistory).not.toHaveBeenCalled();
	});

	it("asks for nothing while the loaded history reaches more than a screen above the view", () => {
		const { scroller, land, pages } = renderPaging();
		expect(onScreen("m1")).toBeLessThan(-scroller.clientHeight);

		// Commits go on arriving, and each one measures; none of them is near.
		land(loaded, 0);
		expect(pages).not.toHaveBeenCalled();
	});

	// The newest page can replay to no rows at all while older history remains;
	// the reserve then only appears with the first message, and has to be
	// watched from there, or a reader scrolling up later is never answered.
	it("watches the reserve of a transcript that started out empty", () => {
		const props = {
			sessionId: "session-1",
			hasMoreHistory: true,
			onLoadMoreHistory: vi.fn(),
		};
		const { rerender } = render(<MessageList {...props} messages={[]} />);
		rerender(<MessageList {...props} messages={loaded} />);

		const reserve = screen.getByTestId("history-reserve");
		expect(
			MockIntersectionObserver.instances.some((o) => o.targets.has(reserve)),
		).toBe(true);
	});

	it("asks for an earlier page when the top of the loaded history comes within a screen of the view", () => {
		const { pages } = renderPaging();

		revealReserve();
		expect(pages).toHaveBeenCalledTimes(1);
	});

	// Ahead of the reader: by the time they reach the top of what is loaded, the
	// page is usually in, and they never see the skeleton at all.
	it("asks before the top of the loaded history is on screen", () => {
		const { scroller, rerender, props, pages } = renderPaging();
		dragRowTo(scroller, "m1", 300);
		expect(onScreen("m1")).toBeLessThan(0);
		expect(onScreen("m1")).toBeGreaterThan(-scroller.clientHeight);

		// Any commit measures, not only the observer's report.
		rerender(
			<MessageList {...props} messages={loaded} loadedHistoryPages={0} />,
		);
		expect(pages).toHaveBeenCalledTimes(1);
	});

	it("holds the rows on screen still when a page lands above them, writing nothing", () => {
		const { scroller, land } = renderPaging();
		// Reading back up is what takes the list off the tail: the state changes on
		// the reader's own scrolling and on nothing else.
		dragRowTo(scroller, "m2");
		revealReserve();
		const top = scroller.scrollTop;
		const at = onScreen("m2");

		land(pagedIn, 1);

		// The page went into the reserve above the rows. Nothing below it moved, so
		// nothing had to be put back — and on iOS putting it back would have been a
		// write that stopped the reader's flick dead.
		expect(onScreen("m2")).toBe(at);
		expect(scroller.scrollTop).toBe(top);
	});

	it("holds the view still when the page is merged into the message it lands above", () => {
		const { scroller, land } = renderPaging();
		// The reader is inside the first row, its top just above the edge.
		dragRowTo(scroller, "m1", 50);
		revealReserve();
		const top = scroller.scrollTop;
		const at = onScreen("m2");

		// The page's last message and this transcript's first one are two halves of
		// one turn, so they are spliced into one bubble that keeps the first one's
		// id: the list is the same length, and the row grows from its top by the
		// two rows' worth of older content now inside it.
		layoutRows((id) => (id === "m1" ? 3 * ROW_HEIGHT : ROW_HEIGHT));
		land(loaded, 1);

		expect(onScreen("m2")).toBe(at);
		expect(scroller.scrollTop).toBe(top);
	});

	it("keeps a scroll the browser has not reported yet when a page lands", () => {
		const { scroller, land } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();

		// A flick still running: the view has moved on, and its scroll event is
		// due at the next frame, after the commit the page lands in.
		scroller.scrollTop += 50;
		const top = scroller.scrollTop;
		const at = onScreen("m2");
		land(pagedIn, 1);

		// Not put back to where the last reported scroll left them.
		expect(scroller.scrollTop).toBe(top);
		expect(onScreen("m2")).toBe(at);
	});

	it("counts growth below the reader once when it lands between the request and a scroll", () => {
		const { scroller, land, viewport } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();

		// Output lands at the end while the page is still in flight, and the reader
		// then scrolls, which takes the seam again over the layout as it now is.
		fitRows(viewport, 1000);
		triggerResize(contentBox(scroller));
		dragTo(scroller, scroller.scrollTop - 50);
		const at = onScreen("m2");

		// Measured against a seam taken before that growth, the page would charge
		// the output a second time and push the reader by it.
		land(pagedIn, 1);
		expect(onScreen("m2")).toBe(at);
	});

	it("moves only the track when output lands below the reader", () => {
		const { scroller, viewport } = renderPaging();
		dragRowTo(scroller, "m2");
		const top = scroller.scrollTop;
		const at = onScreen("m2");
		const height = scroller.scrollHeight;

		fitRows(viewport, 1400);
		triggerResize(contentBox(scroller));

		// The track grew by what was added below, so the rows' top stayed where it
		// was in it; the view is where it was, and so is everything the reader sees.
		expect(scroller.scrollHeight).toBe(height + 400);
		expect(scroller.scrollTop).toBe(top);
		expect(onScreen("m2")).toBe(at);
	});

	it("writes nothing to the scroll position until the reader has stopped scrolling", () => {
		vi.useFakeTimers();
		const { scroller, land, viewport } = renderPaging();
		const writes = vi.spyOn(scroller, "scrollTop", "set");
		dragRowTo(scroller, "m2");
		revealReserve();
		writes.mockClear();
		const at = onScreen("m2");

		// Everything that used to be held still by a write, while the reader's
		// flick is still under way: a page above, output below, a row above them
		// settling on a new height, and history running out.
		land(pagedIn, 1);
		fitRows(viewport, 1200);
		triggerResize(contentBox(scroller));
		layoutRows((id) => (id === "older2" ? 2 * ROW_HEIGHT : ROW_HEIGHT));
		triggerResize(contentBox(scroller));
		land(pagedIn, 2, { hasMoreHistory: false });

		expect(writes).not.toHaveBeenCalled();
		expect(onScreen("m2")).toBe(at);

		// At rest, the track is put right in one go, with the view moved by as much
		// as the rows moved inside it.
		act(() => vi.advanceTimersByTime(200));
		expect(writes).toHaveBeenCalledTimes(1);
		expect(onScreen("m2")).toBe(at);
	});

	it("brings what went past the top back into reach once the view is at rest", () => {
		vi.useFakeTimers();
		const { scroller, land } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();
		const at = onScreen("m2");

		// A page taller than the reserve over the rows: what does not fit goes past
		// the top of the track, where no scroll can reach it yet.
		const older = Array.from({ length: 8 }, (_, i) =>
			textMessage(`older${i + 1}`),
		);
		land([...older, ...loaded], 1);
		const reach = (id: string) => scroller.scrollTop + onScreen(id);
		expect(reach("older1")).toBeLessThan(0);
		expect(onScreen("m2")).toBe(at);

		act(() => vi.advanceTimersByTime(200));

		// The track was grown back to the rows plus a fresh reserve of a screen,
		// and the view moved down with the rows: nothing on screen moved.
		expect(reach("older1")).toBe(scroller.clientHeight);
		expect(
			screen.getByTestId("history-reserve").getBoundingClientRect().height,
		).toBe(scroller.clientHeight);
		expect(onScreen("m2")).toBe(at);
	});

	it("does not come to rest while a finger is on the screen", () => {
		vi.useFakeTimers();
		const { scroller, land } = renderPaging();
		const writes = vi.spyOn(scroller, "scrollTop", "set");
		fireEvent.touchStart(scroller);
		dragRowTo(scroller, "m2");
		revealReserve();
		writes.mockClear();

		land(pagedIn, 1);
		// Held still, the reader is about to move the view again: anything written
		// now would be fought by their finger.
		act(() => vi.advanceTimersByTime(1000));
		expect(writes).not.toHaveBeenCalled();

		fireEvent.touchEnd(scroller);
		act(() => vi.advanceTimersByTime(200));
		expect(writes).toHaveBeenCalled();
	});

	it("puts the track right before going back to the end", async () => {
		vi.useFakeTimers();
		const { scroller, land } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();
		land(
			[...Array.from({ length: 8 }, (_, i) => textMessage(`o${i}`)), ...loaded],
			1,
		);

		fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));

		// A move the reader asked for writes the position anyway, so it is made
		// against the track as it will stay — not one a later rest would shift.
		expect(scroller.scrollTop + onScreen("o0")).toBe(scroller.clientHeight);
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});

	it("does not even ask while the prop says a page is in flight", () => {
		const { rerender, props, calls } = renderPaging();

		revealReserve();
		expect(calls).toHaveBeenCalledTimes(1);

		// The observer goes on watching the reserve, which is still in range. The
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
		revealReserve();
		expect(calls).toHaveBeenCalledTimes(1);
	});

	it("reads the tail again when a reconnect replaces the transcript", () => {
		const { scroller, land } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();
		land(pagedIn, 1);

		// The connection drops, and re-subscribing lands back on the newest page:
		// the transcript is replaced and the page count starts over. An anchor names
		// a row in there at an offset it was never measured against, and the newest
		// page is what was just asked for.
		land(pagedIn.slice(1), 0);

		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});

	it("holds the anchor as the page that landed goes on rendering", () => {
		const { scroller, land } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();
		land(pagedIn, 1);
		const at = onScreen("m2");

		// A diagram inside the page that just landed finishes rendering, and every
		// row doubles in height — the reader's own too, below its top edge. Nothing
		// about that is a case of its own: it is one more resize, and the anchor is
		// held on the frame it arrives in — there is no window after which it stops
		// being held, so nothing has to guess how long rendering takes.
		stretchRows(2);
		triggerResize(contentBox(scroller));
		expect(onScreen("m2")).toBe(at);
	});

	it("asks again when the page that landed leaves the top of history within a screen", () => {
		const { scroller, land, pages } = renderPaging();
		// Up to the top of the loaded rows, with the reserve's last few pixels
		// showing above them.
		dragRowTo(scroller, "m1", -10);
		revealReserve();
		const at = onScreen("m2");

		// Two rows went in above the reader: less than a screen, so the reader is
		// still not a page ahead, and the commit the page landed in asks for the
		// next one — without the reader having moved.
		land(pagedIn, 1);
		expect(onScreen("m2")).toBe(at);
		expect(pages).toHaveBeenCalledTimes(2);
	});

	it("stops asking once the page that landed takes the top of history more than a screen up", () => {
		const { scroller, land, pages } = renderPaging();
		dragRowTo(scroller, "m1", -10);
		revealReserve();

		const older = Array.from({ length: 8 }, (_, i) =>
			textMessage(`older${i + 1}`),
		);
		land([...older, ...loaded], 1);

		// A page ahead of the reader again: they have what they asked for and
		// nothing asks for more until they read on up.
		expect(onScreen("older1")).toBeLessThan(-scroller.clientHeight);
		expect(pages).toHaveBeenCalledTimes(1);
	});

	it("keeps filling a viewport the transcript does not reach the bottom of", () => {
		const { land, pages } = renderPaging({ below: 0 });
		// Shorter than the view, so the reserve stays in view however well the page
		// lands, and the rows on the bottom edge do not move either. An observer
		// reports crossings and there is no crossing to report, so what keeps this
		// going is the list measuring the reserve itself, on the commit the page
		// landed in.
		const at = onScreen("m2");
		revealReserve();

		land(pagedIn, 1);
		expect(onScreen("m2")).toBe(at);
		expect(pages).toHaveBeenCalledTimes(2);
	});

	// The whole of "a short conversation fills up and then stops". Paging on a
	// state has to be shown to settle, and to settle on the right number: one
	// request per page and not one more, with the reader untouched throughout.
	it("fills the top page after page and stops at the start of the conversation", () => {
		const { land, pages, calls } = renderPaging({ below: 0 });
		// Shorter than the view, so nothing the paging does can move the rows: they
		// sit on the bottom edge and a page fills the reserve above them. No crossing
		// ever happens — and the observer is never rebuilt either, so it reports once
		// and then has nothing to say. What carries this is the list measuring the
		// reserve on each commit.

		/** The rows a page at a time brings in, oldest first. */
		const older = (pageCount: number) =>
			[...Array(pageCount).keys()].map((i) =>
				textMessage(`older${pageCount - i}`),
			);
		/**
		 * Every page goes in above the row the reader is looking at, so where it
		 * sits on the screen is the number that must not move: the reader asked for
		 * history, not to be taken somewhere else.
		 */
		const startedAt = onScreen("m2");

		revealReserve();
		expect(pages).toHaveBeenCalledTimes(1);

		// One message per page, and three pages before the server runs out: enough
		// that neither trigger can have carried it on its own, which two pages could
		// not have shown.
		land([...older(1), ...loaded], 1);
		expect(pages).toHaveBeenCalledTimes(2);
		expect(onScreen("m2")).toBe(startedAt);

		land([...older(2), ...loaded], 2);
		expect(pages).toHaveBeenCalledTimes(3);
		expect(onScreen("m2")).toBe(startedAt);

		// The last page, and the server says so with it.
		land([...older(3), ...loaded], 3, { hasMoreHistory: false });
		expect(screen.getByText("Beginning of conversation")).toBeInTheDocument();
		expect(onScreen("m2")).toBe(startedAt);

		// Three pages arrived, three were asked for, and nothing was asked for that
		// was refused: the list stopped on the answer rather than on a request it
		// then had to take back. Commits go on arriving afterwards and none of them
		// asks.
		land([...older(3), ...loaded], 3, { hasMoreHistory: false });
		expect(pages).toHaveBeenCalledTimes(3);
		expect(calls).toHaveBeenCalledTimes(3);
	});

	it("stops asking when a page fails, and asks again once the error clears", () => {
		const { land, pages } = renderPaging({ below: 0 });
		// The short transcript again: the reserve stays on screen whatever happens,
		// so nothing about the view is going to stop this on its own.
		revealReserve();
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
		revealReserve();
		expect(pages).toHaveBeenCalledTimes(1);

		// A page whose records render to nothing: the cursor moved on, the
		// transcript did not, and the reserve is still on screen. Asking again is
		// what gets the reader past it, and it is bounded without a gate of its own
		// — every request moves the cursor further back and history is finite.
		land(loaded, 1);
		expect(pages).toHaveBeenCalledTimes(2);
	});

	it("lets a jump back to the tail take the view over from the anchor", () => {
		const { scroller, land } = renderPaging();
		dragTo(scroller, 0);
		revealReserve();
		land(pagedIn, 1);

		fireEvent.click(screen.getByRole("button", { name: "Scroll to bottom" }));

		// The page that landed finishes rendering. Holding the anchor now would undo
		// the jump the reader just asked for.
		stretchRows(2);
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});

	it("stops cleanly once the server says there is nothing older", () => {
		const { scroller, land, pages } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();

		// The last page, and with it the reserve: nothing is left to observe or to
		// measure, so nothing can ask again.
		land(pagedIn, 1, { hasMoreHistory: false });

		expect(pages).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Beginning of conversation")).toBeInTheDocument();
	});

	it("does not read the tail again because the page landed under a sent message", () => {
		const { scroller, land } = renderPaging();
		const sent = [...loaded, userMessage("sent")];
		land(sent, 0);
		dragRowTo(scroller, "m2");
		revealReserve();
		const at = onScreen("m2");

		// The newest row is one the reader typed, and it is still the newest row
		// after the page lands: a prepend adds nothing at the end, so nothing about
		// it says they want to be back there.
		land([textMessage("older1"), textMessage("older2"), ...sent], 1);

		expect(onScreen("m2")).toBe(at);
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
	});

	it("keeps the reader where they are when the first row is gone", () => {
		const { scroller, land } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();
		const top = scroller.scrollTop;

		// The page landed, but the row whose bottom edge it is measured by is not
		// in the list any more, so nothing says how much went in above the reader.
		// Staying put is the answer; going back to the tail would take the reader
		// off the history they asked for.
		land([textMessage("older1"), textMessage("older2"), loaded[1]], 1);

		expect(scroller.scrollTop).toBe(top);
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
		// Nothing watches the reserve while a page has failed, so the failure
		// cannot spin into a retry loop the user never asked for.
		revealReserve();
		expect(onLoadMoreHistory).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);
	});

	// Loading is not announced: pages are asked for without the reader asking and
	// mostly land out of sight, so a live region would speak on every one.
	it("draws earlier messages to come as decoration, saying nothing", () => {
		render(
			<MessageList
				sessionId="session-1"
				messages={[textMessage("m1")]}
				hasMoreHistory
				isLoadingMoreHistory
			/>,
		);

		const reserve = screen.getByTestId("history-reserve");
		expect(reserve.firstElementChild).toHaveAttribute("aria-hidden", "true");
		expect(reserve).toHaveTextContent("");
		expect(screen.queryByRole("status")).toBeNull();
	});

	// The last page usually lands mid-flick, and the space it leaves stays until
	// the view is at rest; a skeleton drawn there would promise history that does
	// not exist.
	it("leaves the space blank once history has run out, and takes it away at rest", () => {
		vi.useFakeTimers();
		const { scroller, land } = renderPaging();
		dragRowTo(scroller, "m2");
		revealReserve();
		const at = onScreen("m2");

		land(pagedIn, 1, { hasMoreHistory: false });

		expect(screen.queryByTestId("history-reserve")).toBeNull();
		const reach = (id: string) => scroller.scrollTop + onScreen(id);
		expect(reach("older1")).toBeGreaterThan(0);
		expect(onScreen("m2")).toBe(at);

		act(() => vi.advanceTimersByTime(200));
		expect(reach("older1")).toBe(0);
		expect(onScreen("m2")).toBe(at);
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
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));

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
		).toBe(maxScrollTop(scroller));
	});

	it("follows again once the user scrolls back to the bottom", () => {
		const { scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		dragTo(scroller, 500);

		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});

	it("pins the tail again when the viewport shrinks under it", () => {
		const { scroller, viewport } = renderFollowing();

		// The software keyboard opens, or the input box grows a line: the content
		// is untouched, only the container it is read through gets shorter.
		viewport.viewportHeight = 250;
		triggerResize(scroller);

		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});

	it("hands the endpoint back to the tail rather than to one frame's bottom", async () => {
		const { scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		await userEvent.click(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		);
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));

		// Syntax highlighting lands and the bottom moves past the offset the button
		// aimed at. Reading the tail is a state, not a destination, so the view goes
		// to the new bottom rather than staying at the one that was current when the
		// button was pressed.
		viewport.contentHeight = 1500;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
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
				{ type: "text", id: "text-above", content: "the part above" },
				{ type: "text", id: "text-read", content: "the part being read" },
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
		vi.useFakeTimers();
		dragTo(scroller, 200);
		const read = () =>
			screen.getByText("the part being read").getBoundingClientRect().top;
		const at = read();

		// A code block inside the part above finishes highlighting, so the part
		// above grows by 150px.
		layout({ partHeights: (id) => (id === "m1" ? [250, 100] : [100]) });
		viewport.contentHeight = 1150;
		triggerResize(contentBox(scroller));

		// Anchored to the row, the reader would be held by the row's top, and the
		// part above would push what they are reading down by its growth.
		expect(read()).toBe(at);

		// The growth went up past the top of the track, and comes back into reach
		// at rest with the view moved down by as much: still nothing on screen
		// moves.
		act(() => vi.advanceTimersByTime(200));
		expect(scroller.scrollTop).toBe(350);
		expect(read()).toBe(at);
	});

	// A row folding into its tool group stays in the DOM, only `hidden`, and an
	// element that is not displayed sits at offset 0 — holding it still took the
	// view to the top of the loaded transcript. Taking a fresh anchor wherever
	// the view then sat left the reader on whatever the fold pulled up under it.
	it("lands the reader on the group's summary when the part they are on folds into it", async () => {
		const bash = (id: string): ContentPart => ({
			type: "tool_call",
			id: `call-${id}`,
			tool: { id, name: "Bash", input: { command: id }, status: "success" },
		});
		const tools: Message = {
			id: "m1",
			role: "assistant",
			status: "complete",
			createdAt: new Date(),
			parts: [bash("a"), bash("b")],
		};
		const { scroller } = renderScrolling([
			textMessage("m0"),
			tools,
			textMessage("m2"),
			textMessage("m3"),
			textMessage("m4"),
		]);
		const user = userEvent.setup();
		const summary = screen.getByRole("button", { name: /Ran 2 commands/ });
		// Open, m1 is its summary and both calls; folded, the summary alone.
		const m1Parts = (parts: number[]) =>
			layout({ partHeights: (id) => (id === "m1" ? parts : [100]) });
		m1Parts([100, 100, 100]);
		await user.click(summary);
		dragTo(scroller, 300);

		// The fold is the list's own state, so it is the content shrinking that
		// reaches the scroll, not a commit of the transcript.
		await user.click(summary);
		m1Parts([100]);
		triggerResize(contentBox(scroller));

		// The summary takes the place of the row the reader was on: at the top
		// of the view, where that row's top was.
		expect(onScreen("m1")).toBe(0);
	});

	// The other half of requiring a *direction*: reaching the end is only a return
	// to the tail when the reader moved there.
	it("stays where it is when content collapsing below brings the end up to the view", () => {
		const { scroller, viewport } = renderFollowing();
		dragTo(scroller, 200);

		// A tool result below the view is collapsed, and the end comes up to meet
		// the view: it is at the end without anyone having scrolled there. The
		// track is not shortened past the view, which would have the browser clamp
		// the view up — a scroll event, the one thing that could be mistaken for
		// the reader arriving at the end.
		viewport.contentHeight = 600;
		triggerResize(contentBox(scroller));
		dragTo(scroller, scroller.scrollTop);
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
		const at = onScreen("m2");

		// Read as a return to the tail, the next output would drag the reader to the
		// bottom of the conversation.
		viewport.contentHeight = 1000;
		triggerResize(contentBox(scroller));
		expect(onScreen("m2")).toBe(at);
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
	});

	// Anchored at the end, the button would sit over the last row's bottom-right
	// controls with no scrolling left that could move them out from under it.
	it("keeps the button off a view anchored at the end until the end moves away", () => {
		const ref = createRef<MessageListHandle>();
		const { scroller, viewport } = renderScrolling(
			[...transcript, permissionMessage("card", "p1")],
			{ box: { contentHeight: 600, viewportHeight: 500 }, ref },
		);

		act(() => ref.current?.jumpToRequest("p1"));
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
		expect(
			screen.queryByRole("button", { name: /Scroll to bottom/ }),
		).toBeNull();

		viewport.contentHeight = 1000;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollTop).toBe(100);
		expect(
			screen.getByRole("button", { name: /Scroll to bottom/ }),
		).toBeInTheDocument();
	});

	// Rows below a pending card — the turn-end slot keeps its height while the
	// turn waits — can hold it more than "near the end" away from the end, so
	// distance cannot be what keeps the button off its answers.
	it("keeps the button off a pending permission card's answers", () => {
		render(
			<MessageList
				sessionId="session-1"
				messages={[...transcript, permissionMessage("card", "p1")]}
				onPermissionRespond={() => {}}
			/>,
		);
		const scroller = scrollContainer();
		stubTranscript(scroller, { contentHeight: 1000, viewportHeight: 500 });
		triggerResize(scroller);
		const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
		vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0, 500));
		const answers = screen.getByRole("button", { name: "Allow" }).parentElement;
		if (!answers) throw new Error("no answer row");
		const answersAt = vi
			.spyOn(answers, "getBoundingClientRect")
			.mockReturnValue(rect(-200, -150));

		dragTo(scroller, 200);
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();

		answersAt.mockReturnValue(rect(440, 490));
		dragTo(scroller, 190);
		expect(
			screen.queryByRole("button", { name: /Scroll to bottom/ }),
		).toBeNull();
	});

	// A send to an idle agent lands with its reply's placeholder below it, so the
	// newest row is not the one the reader typed.
	it("returns to the tail when a send to an idle agent opens a reply below it", () => {
		const { rerender, scroller } = renderFollowing();
		dragTo(scroller, 200);

		rerender(
			<MessageList
				sessionId="session-1"
				messages={[
					...transcript,
					userMessage("sent"),
					{
						id: "reply",
						role: "assistant",
						status: "streaming",
						createdAt: new Date(),
						parts: [],
					},
				]}
			/>,
		);

		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});

	// Re-subscribing replays history with fresh ids. With no older page loaded the
	// page count has nothing to drop, so the replacement is all there is to go on.
	it("returns to the tail when a reconnect replaces the transcript", () => {
		const { rerender, scroller } = renderFollowing();
		dragTo(scroller, 200);

		rerender(
			<MessageList
				sessionId="session-1"
				messages={transcript.map((m) => ({ ...m, id: `${m.id}-replayed` }))}
			/>,
		);

		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
		expect(
			screen.queryByRole("button", { name: /Scroll to bottom/ }),
		).toBeNull();
	});

	// The newest row before the send can be an empty reply bubble, which the
	// send's own turn closing drops.
	it("returns to the tail when a send drops the empty bubble it lands after", () => {
		const emptyReply: Message = {
			id: "empty",
			role: "assistant",
			status: "complete",
			createdAt: new Date(),
			parts: [],
		};
		const { rerender, scroller } = renderScrolling([...transcript, emptyReply]);
		dragTo(scroller, 200);

		rerender(
			<MessageList
				sessionId="session-1"
				messages={[...transcript, userMessage("sent")]}
			/>,
		);

		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});

	// Taking an empty reply bubble back out removes the newest row, which is not a
	// replacement and must not drag the reader to the end.
	it("stays put when the newest row is taken back out", () => {
		const { rerender, scroller } = renderFollowing();
		dragTo(scroller, 200);

		rerender(
			<MessageList sessionId="session-1" messages={transcript.slice(0, -1)} />,
		);

		expect(scroller.scrollTop).toBe(200);
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
			name === "typed by the user" ? maxScrollTop(scroller) : 200,
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
		const viewport = stubTranscript(scroller, {
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
		const viewport = stubTranscript(scroller, {
			contentHeight: 0,
			viewportHeight: 500,
		});
		fitRows(viewport, 800);
		triggerResize(scroller);

		// Reading back up to the top is what brings the reserve into view at all.
		dragRowTo(scroller, "m1");
		revealReserve();

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
		const at = onScreen("m1");

		// Output goes on landing at the end. The user is reading up here, so this
		// must not be taken as licence to jump to the bottom.
		fitRows(viewport, 1200);
		triggerResize(contentBox(scroller));
		expect(onScreen("m1")).toBe(at);
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

		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});
});

// Putting the track right waits for the view to be at rest — nothing pressed,
// nothing scrolling — so whatever can leave "pressed" standing leaves the track
// wrong for good: rows past its top out of reach, the reserve never restored.
describe("MessageList coming to rest", () => {
	const transcript = Array.from({ length: 5 }, (_, i) =>
		textMessage(`m${i + 1}`),
	);

	/**
	 * Output lands while the reader is not at rest: reading the tail it goes up
	 * past the track's top, and only coming to rest grows the track to take it.
	 */
	function growWhileHeld(scroller: HTMLElement, viewport: ScrollBox) {
		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(scroller.scrollHeight).toBe(1000);
	}

	it("comes to rest when a finger lifts off a row that left the transcript under it", () => {
		vi.useFakeTimers();
		const { rerender, scroller, viewport } = renderScrolling(transcript);
		const finger = screen.getByText("text m3");
		fireEvent.touchStart(finger);

		// The row the finger is on is replaced, so the end of the touch goes to a
		// node no longer in the document, and bubbles nowhere it can be heard.
		rerender(
			<MessageList
				sessionId="session-1"
				messages={transcript.filter((m) => m.id !== "m3")}
			/>,
		);
		growWhileHeld(scroller, viewport);
		fireEvent.touchEnd(finger);
		act(() => vi.advanceTimersByTime(200));

		expect(scroller.scrollHeight).toBe(1400);
	});

	// A pen pan is taken over by the browser like a finger's, with a
	// `pointercancel` while the pen is still down; only the touch events say
	// when it lifts.
	it("does not come to rest while a pen is still down", () => {
		vi.useFakeTimers();
		const { scroller, viewport } = renderScrolling(transcript);
		fireEvent.touchStart(scroller);
		fireEvent.pointerDown(scroller, { pointerType: "pen" });
		fireEvent.pointerCancel(window, { pointerType: "pen" });

		growWhileHeld(scroller, viewport);
		act(() => vi.advanceTimersByTime(1000));
		expect(scroller.scrollHeight).toBe(1000);

		fireEvent.touchEnd(scroller);
		act(() => vi.advanceTimersByTime(200));
		expect(scroller.scrollHeight).toBe(1400);
	});

	// Chromium can leave out the `pointerup` after a scrollbar drag; the mouse
	// moving on with no button down is the release it never sent.
	it("comes to rest once a mouse moves with no button down after a press with no release", () => {
		vi.useFakeTimers();
		const { scroller, viewport } = renderScrolling(transcript);
		fireEvent.pointerDown(scroller, { pointerType: "mouse", buttons: 1 });

		growWhileHeld(scroller, viewport);
		fireEvent.pointerMove(window, { pointerType: "mouse", buttons: 1 });
		act(() => vi.advanceTimersByTime(1000));
		expect(scroller.scrollHeight).toBe(1000);

		fireEvent.pointerMove(window, { pointerType: "mouse", buttons: 0 });
		act(() => vi.advanceTimersByTime(200));
		expect(scroller.scrollHeight).toBe(1400);
	});

	// The transcript emptying mid-press takes the scroller, and the end of the
	// press, with it.
	it("is at rest in a scroller that came back after one went away mid-press", () => {
		const { rerender, scroller } = renderScrolling(transcript);
		fireEvent.pointerDown(scroller, { pointerType: "mouse" });

		rerender(<MessageList sessionId="session-1" messages={[]} />);
		rerender(<MessageList sessionId="session-1" messages={transcript} />);
		const next = scrollContainer();
		const viewport = stubTranscript(next, {
			contentHeight: 1000,
			viewportHeight: 500,
		});
		triggerResize(next);

		expect(next.scrollHeight).toBe(1000);
		viewport.contentHeight = 1400;
		triggerResize(contentBox(next));
		expect(next.scrollHeight).toBe(1400);
	});

	// StrictMode runs every effect's cleanup once on a list that stays mounted.
	it("is at rest after mounting under StrictMode", () => {
		render(
			<StrictMode>
				<MessageList sessionId="session-1" messages={transcript} />
			</StrictMode>,
		);
		const scroller = scrollContainer();
		const viewport = stubTranscript(scroller, {
			contentHeight: 1000,
			viewportHeight: 500,
		});
		triggerResize(scroller);

		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));

		expect(scroller.scrollHeight).toBe(1400);
		expect(scroller.scrollTop).toBe(maxScrollTop(scroller));
	});

	// Rows sit on the track's bottom edge, so with no place held, output landing
	// below would carry everything the reader sees up the screen.
	it("holds the reader by what they now see once the row they were on is gone", () => {
		const { rerender, scroller, viewport } = renderScrolling(transcript);
		dragRowTo(scroller, "m3");

		rerender(
			<MessageList
				sessionId="session-1"
				messages={transcript.filter((m) => m.id !== "m3")}
			/>,
		);
		const at = onScreen("m4");

		viewport.contentHeight = 1400;
		triggerResize(contentBox(scroller));
		expect(onScreen("m4")).toBe(at);
	});
});

describe("the scroll button's new-content dot", () => {
	const transcript = Array.from({ length: 5 }, (_, i) =>
		textMessage(`m${i + 1}`),
	);

	function leaveTail() {
		const view = renderScrolling(transcript);
		dragTo(view.scroller, 200);
		return view;
	}

	const dot = () => screen.queryByTestId("unseen-dot");

	it("appears when the last message streams more output after the reader left", () => {
		const { rerender } = leaveTail();
		expect(dot()).toBeNull();

		const last = transcript[transcript.length - 1];
		if (last.role !== "assistant") throw new Error("fixture");
		rerender(
			<MessageList
				sessionId="session-1"
				messages={[
					...transcript.slice(0, -1),
					{
						...last,
						parts: [
							...last.parts,
							{ type: "text", id: "text-more", content: "more" },
						],
					},
				]}
			/>,
		);

		expect(dot()).not.toBeNull();
		expect(
			screen.getByRole("button", { name: "Scroll to bottom, new messages" }),
		).toBeInTheDocument();
	});

	it("appears when a new message lands at the end", () => {
		const { rerender } = leaveTail();
		rerender(
			<MessageList
				sessionId="session-1"
				messages={[...transcript, textMessage("m6")]}
			/>,
		);
		expect(dot()).not.toBeNull();
	});

	// Neither is anything the reader has not seen: a backfilled sequence number
	// replaces the message object without touching what it shows, and a page of
	// older history grows the transcript at the other end.
	it.each([
		[
			"the last message is only backfilled",
			[
				...transcript.slice(0, -1),
				{ ...transcript[transcript.length - 1], anchorSeq: 7 },
			] as Message[],
		],
		["an older page lands above", [textMessage("older"), ...transcript]],
	])("stays off when %s", (_, messages) => {
		const { rerender } = leaveTail();
		rerender(<MessageList sessionId="session-1" messages={messages} />);
		expect(dot()).toBeNull();
	});

	it("appears when the turn at the end fails", () => {
		const { rerender } = leaveTail();
		const last = transcript[transcript.length - 1];
		rerender(
			<MessageList
				sessionId="session-1"
				messages={[
					...transcript.slice(0, -1),
					{ ...last, status: "error", error: "boom" } as Message,
				]}
			/>,
		);
		expect(dot()).not.toBeNull();
	});

	// The newest row absorbs the older half of its own turn when a page lands, so
	// its parts change without anything new at the end.
	it("stays off when a page joins onto the newest row", () => {
		const { rerender } = leaveTail();
		const last = transcript[transcript.length - 1];
		if (last.role !== "assistant") throw new Error("fixture");
		rerender(
			<MessageList
				sessionId="session-1"
				loadedHistoryPages={1}
				messages={[
					...transcript.slice(0, -1),
					{
						...last,
						parts: [
							{ type: "text", id: "text-older", content: "older half" },
							...last.parts,
						],
					},
				]}
			/>,
		);
		expect(dot()).toBeNull();
	});

	// Coming back within reach of the end shows the end, even where it is not a
	// return to the tail.
	it("clears once the reader comes within reach of the end", () => {
		const { rerender, scroller, viewport } = leaveTail();
		rerender(
			<MessageList
				sessionId="session-1"
				messages={[...transcript, textMessage("m6")]}
			/>,
		);
		expect(dot()).not.toBeNull();

		// The end comes up to the view as the content shrinks under it, and the
		// reader then moves upward, so it stays anchored: the end was reached by
		// the content, not by the reader scrolling down to it.
		viewport.contentHeight = 520;
		triggerResize(contentBox(scroller));
		dragTo(scroller, scroller.scrollTop - 10);
		expect(dot()).toBeNull();

		viewport.contentHeight = 1000;
		triggerResize(contentBox(scroller));
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
	});

	it("clears once the reader is back at the tail", async () => {
		const { rerender, scroller } = leaveTail();
		const grown = [...transcript, textMessage("m6")];
		rerender(<MessageList sessionId="session-1" messages={grown} />);

		await userEvent.click(
			screen.getByRole("button", { name: "Scroll to bottom, new messages" }),
		);
		dragTo(scroller, 200);

		// Left again with nothing new since: the button is back, the dot is not.
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
		expect(dot()).toBeNull();
	});
});

// Children that loaded flat, before their call did, stay where they are; the
// call's row in another bubble still counts them (docs/tool-call-ui.md#what-is-not-filed).
describe("a subagent's unfiled children", () => {
	it("are counted by their call's row", () => {
		const message = (id: string, parts: ContentPart[]): Message => ({
			id,
			role: "assistant",
			status: "complete",
			createdAt: new Date(),
			parts,
		});
		const read = (id: string, parentToolUseId?: string): ContentPart => ({
			type: "tool_call",
			id: `call-${id}`,
			tool: {
				id,
				name: "Read",
				input: { file_path: "/a.go" },
				status: "success",
			},
			...(parentToolUseId ? { parentToolUseId } : {}),
		});
		render(
			<MessageList
				sessionId="session-1"
				messages={[
					message("m1", [
						{
							type: "tool_call",
							id: "call-t1",
							tool: {
								id: "t1",
								name: "Agent",
								input: { description: "find usages" },
								status: "success",
								result: "done",
								children: [read("c1")],
							},
						},
					]),
					message("m2", [read("c2", "t1"), read("c3", "t1")]),
				]}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /find usages/ }),
		).toHaveAccessibleName(/3 steps/);
	});
});
