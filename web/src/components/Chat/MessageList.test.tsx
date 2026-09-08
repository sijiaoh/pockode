import { act, render, screen, waitFor } from "@testing-library/react";
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
	targets = new Set<Element>();

	callback: IntersectionObserverCallback;

	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
		MockIntersectionObserver.instances.push(this);
	}

	observe(target: Element) {
		this.targets.add(target);
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

beforeEach(() => {
	MockIntersectionObserver.instances = [];
	globalThis.IntersectionObserver =
		MockIntersectionObserver as unknown as typeof globalThis.IntersectionObserver;
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
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

	it("widens the pagination window before jumping to a question outside it", async () => {
		const messages: Message[] = [
			questionMessage("m0", "r1"),
			...Array.from({ length: 80 }, (_, i) => textMessage(`m${i + 1}`)),
		];
		renderList(messages);

		// Outside the render window: no DOM node exists, so it counts as hidden.
		expect(questionCard("r1")).toBeNull();
		const button = await findPill("Jump to unanswered question");

		await userEvent.click(button);
		expect(questionCard("r1")).not.toBeNull();
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
		// Proxy for the internal at-bottom flag having been dropped: widening the
		// window grows the content, and an auto-follow that still believed the user
		// was at the tail would scroll straight back down over the jump.
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeInTheDocument();
	});
});
