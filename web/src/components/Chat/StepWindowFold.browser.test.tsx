import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { TurnTail } from "../../lib/thinking";
import type {
	ContentPart,
	Message,
	ToolRun,
	ToolRunStatus,
} from "../../types/message";
import MessageList from "./MessageList";
import { IDLE_TAIL } from "./turnTailContext";

// docs/tool-call-ui.md#the-step-window, on a phone: a reader following the
// tail sees no row grow or fold under them while a subagent works and settles.

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** The observers report a frame late, and their update commits a frame on. */
async function settle() {
	for (let i = 0; i < 3; i++) await act(nextFrame);
}

const FILLER =
	"The quick brown fox jumps over the lazy dog, and then it does it again, slowly, so that this paragraph wraps onto several lines at any width.";

const RUNNING: TurnTail = { ...IDLE_TAIL, phase: "running" };

const step = (id: string, status: ToolRunStatus): ContentPart => ({
	type: "tool_call",
	id: `call-${id}`,
	tool: {
		id,
		name: "Read",
		input: { file_path: `/repo/${id}.go` },
		status,
	},
});

/** A subagent that has taken `taken` steps, the newest still running. */
function subagent(taken: number, status: ToolRunStatus): ContentPart {
	const settled = status !== "running";
	const children = Array.from({ length: taken }, (_, i) =>
		step(`s${i}`, settled || i < taken - 1 ? "success" : "running"),
	);
	const run: ToolRun = {
		id: "t1",
		name: "Agent",
		input: { description: "Find retry handling", subagent_type: "Explore" },
		status,
		children,
		...(settled
			? { result: "Retries honour Retry-After.", durationMs: 9000 }
			: {}),
	};
	return { type: "tool_call", id: "call-t1", tool: run };
}

const text = (id: string, paragraphs: number): ContentPart => ({
	type: "text",
	id,
	content: Array.from({ length: paragraphs }, () => FILLER).join("\n\n"),
});

/**
 * Earlier turns, so the transcript scrolls, the last of them ending on
 * `before`; then the open reply.
 */
function messages(
	reply: ContentPart[],
	open = true,
	before: ContentPart[] = [],
): Message[] {
	const earlier: Message[] = Array.from({ length: 4 }, (_, i) => ({
		id: `a${i}`,
		role: "assistant",
		status: "complete",
		createdAt: new Date(0),
		parts: [text(`earlier-${i}`, 2), ...(i === 3 ? before : [])],
	}));
	return [
		...earlier,
		{
			id: "u",
			role: "user",
			content: "Find the retry handling",
			status: "complete",
			createdAt: new Date(0),
		},
		{
			id: "open",
			role: "assistant",
			status: open ? "streaming" : "complete",
			createdAt: new Date(0),
			parts: reply,
		},
	];
}

function List({ list, tail }: { list: Message[]; tail: TurnTail }) {
	return (
		<div className="flex flex-col" style={{ height: 640, width: 360 }}>
			<MessageList sessionId="fold" messages={list} tail={tail} />
		</div>
	);
}

function rendered(list: Message[], tail: TurnTail = RUNNING) {
	const view = render(<List list={list} tail={tail} />);
	const scroller =
		view.container.querySelector<HTMLElement>(".overflow-y-auto");
	if (!scroller) throw new Error("the transcript has no scroll container");
	const row = () => {
		const el = scroller.querySelector<HTMLElement>('[data-tool-use-id="t1"]');
		if (!el) throw new Error("the subagent row is not drawn");
		return el;
	};
	return {
		scroller,
		row,
		hasWindow: () => row().querySelector("[data-step-window]") !== null,
		/**
		 * The row's place in what scrolls. Not `offsetTop`: each message row is
		 * layout-contained, which makes it the `offsetParent` of what it holds.
		 */
		contentTop: () =>
			row().getBoundingClientRect().top -
			scroller.getBoundingClientRect().top +
			scroller.scrollTop,
		/** Where the row sits on screen, and how tall it is. */
		box: () => {
			const rect = row().getBoundingClientRect();
			return {
				top: Math.round(rect.top - scroller.getBoundingClientRect().top),
				height: Math.round(rect.height),
			};
		},
		update: async (next: Message[], nextTail: TurnTail = RUNNING) => {
			view.rerender(<List list={next} tail={nextTail} />);
			await settle();
		},
		scrollTo: async (top: number) => {
			scroller.scrollTop = top;
			await settle();
		},
	};
}

describe("the step window on a phone", () => {
	beforeEach(async () => {
		await page.viewport(360, 640);
	});

	// A lone row on a phone gets two lines: it grows once, at its second
	// step, and moves nothing after that until it has settled.
	it("grows to its size, then moves nothing until it has settled", async () => {
		const t = rendered(messages([subagent(0, "running")]));
		await settle();
		expect(t.hasWindow()).toBe(false);

		const atBottom = () =>
			t.scroller.scrollHeight - t.scroller.clientHeight - t.scroller.scrollTop;
		await t.update(messages([subagent(1, "running")]));
		expect(t.hasWindow()).toBe(true);
		const one = t.box();
		expect(atBottom()).toBeLessThanOrEqual(1);

		await t.update(messages([subagent(2, "running")]));
		const first = t.box();
		expect(first.height).toBeGreaterThan(one.height);
		expect(atBottom()).toBeLessThanOrEqual(1);

		for (const taken of [3, 5]) {
			await t.update(messages([subagent(taken, "running")]));
			expect(t.box()).toEqual(first);
		}
		// Settled in view, while the turn is still open: frozen, not folded.
		await t.update(messages([subagent(5, "success")]));
		expect(t.hasWindow()).toBe(true);
		expect(t.box()).toEqual(first);
		expect(atBottom()).toBeLessThanOrEqual(1);
	});

	it("folds a frozen window only once it is out of view, and keeps it folded", async () => {
		// The reply goes on below the row for well over a screen, so the row
		// can be scrolled away while its turn is still open.
		const after = text("after", 12);
		const t = rendered(messages([subagent(3, "running"), after]));
		await settle();
		await t.scrollTo(t.contentTop() - 40);
		const inView = t.scroller.scrollTop;
		expect(t.hasWindow()).toBe(true);

		// It settles in front of the reader: frozen, not folded.
		await t.update(messages([subagent(3, "success"), after]));
		expect(t.hasWindow()).toBe(true);
		const frozen = t.box();
		// Output landing below it folds nothing either.
		await t.update(messages([subagent(3, "success"), after, text("more", 1)]));
		expect(t.box()).toEqual(frozen);

		await t.scrollTo(t.scroller.scrollHeight);
		expect(t.hasWindow()).toBe(false);
		await t.scrollTo(inView);
		expect(t.hasWindow()).toBe(false);

		// Drawn afresh — as a group closed and opened again would draw it — the
		// row is still folded: the latch is the list's, not the row's.
		const drawn = t.row();
		const remounted = { ...subagent(3, "success"), id: "call-t1-again" };
		await t.update(messages([remounted, after, text("more", 1)]));
		expect(t.row()).not.toBe(drawn);
		expect(t.hasWindow()).toBe(false);
	});

	// A Codex subagent resumed this turn runs again on its spawn's row, in an
	// earlier reply; settling there is settling in this turn.
	it("keeps the frozen window of a run resumed this turn from an earlier reply", async () => {
		const reply = [text("now", 1)];
		const t = rendered(messages(reply, true, [subagent(3, "running")]));
		await settle();
		await t.scrollTo(t.contentTop() - 40);
		expect(t.hasWindow()).toBe(true);
		await t.update(messages(reply, true, [subagent(3, "success")]));
		expect(t.hasWindow()).toBe(true);
		await t.update(messages(reply, false, [subagent(3, "success")]), IDLE_TAIL);
		expect(t.hasWindow()).toBe(false);
	});

	// A reload into an open turn, the reader at the tail: the row is out of
	// view from its first frame, so it is never drawn frozen.
	it("folds a settled row that mounts out of view", async () => {
		const t = rendered(messages([subagent(3, "success"), text("after", 12)]));
		expect(t.hasWindow()).toBe(false);
	});

	it("folds a frozen window in view at the turn's end", async () => {
		const reply = [subagent(3, "success")];
		const t = rendered(messages(reply));
		await settle();
		expect(t.hasWindow()).toBe(true);
		await t.update(messages(reply, false), IDLE_TAIL);
		expect(t.hasWindow()).toBe(false);
	});
});
