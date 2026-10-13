import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type RenderedTranscript,
	renderTranscript,
} from "../../test/transcriptFixture";
import type { Message } from "../../types/message";
import MessageList from "./MessageList";

vi.mock("../../lib/wsStore", async (importOriginal) =>
	(await import("../../test/chatHistoryServer")).stubChatHistoryRpc(
		await importOriginal<typeof import("../../lib/wsStore")>(),
	),
);

const FILLER =
	"The quick brown fox jumps over the lazy dog, and then it does it again, slowly, so that this paragraph wraps onto several lines at any width.";

const say = (content: string) => ({ type: "message", content });
/** A paragraph led by `marker`, which is what a test finds it by. */
const write = (marker: string) => ({
	type: "text",
	content: `${marker}\n\n${FILLER}\n\n${FILLER}`,
});
const run = (id: string) => [
	{
		type: "tool_call",
		tool_use_id: id,
		tool_name: "Bash",
		tool_input: { command: `echo ${id}` },
	},
	{ type: "tool_result", tool_use_id: id, tool_result: id },
];
const done = { type: "done" };

function turns(from: number, count: number): unknown[] {
	return Array.from({ length: count }, (_, i) => [
		say(`Question ${from + i}`),
		write(`Answer ${from + i}.`),
		done,
	]).flat();
}

/**
 * What the reader is looking at when they reach the top of the loaded history:
 * the first paragraph the newest page's first bubble writes after its calls.
 */
const READER_LINE = "Reading here.";

/**
 * A long session in three pages. The newest one opens with a multi-part
 * assistant bubble — calls, then prose — and below it enough turns to need
 * scrolling up to reach it.
 *
 * `cutInsideTurn` decides where the page above ends. Inside that bubble's turn,
 * the page's last records are the turn's first half, so `prependHistoryPage`
 * splices them into the bubble on screen. Otherwise the page above holds a turn
 * of its own, ended, and the newest page opens on a message of its own above
 * the same bubble — one row more, and nothing to splice.
 */
function session(cutInsideTurn: boolean): unknown[][] {
	const oldest = turns(1, 3);
	const firstHalf = [
		say("Start the work"),
		write("Earlier half."),
		...run("t1"),
	];
	const secondHalf = [...run("t2"), ...run("t3"), write(READER_LINE), done];
	const below = turns(10, 6);
	return cutInsideTurn
		? [oldest, firstHalf, [...secondHalf, ...below]]
		: [
				oldest,
				[...firstHalf, done],
				[say("Carry on"), ...secondHalf, ...below],
			];
}

/**
 * Puts the reader at the top of the loaded rows, with the last few pixels of
 * the reserve over them showing — a page has been asked for by then, on the
 * way up — and waits for the view to come to rest there.
 */
async function readToTop(transcript: RenderedTranscript) {
	const { scroller } = transcript;
	const first = scroller.querySelector("[data-message-id]");
	if (!first) throw new Error("no rows");
	await transcript.scrollTo(
		scroller.scrollTop +
			first.getBoundingClientRect().top -
			scroller.getBoundingClientRect().top -
			10,
	);
	await transcript.rest();
	expect(transcript.requests()).toBe(1);
}

/**
 * The reader's line is where it was, to the pixel the anchor can promise: a
 * move under a pixel is not written at all (`DRIFT_TOLERANCE` in
 * `useTranscriptScroll`).
 */
function expectHeldStill(
	transcript: RenderedTranscript,
	before: number,
	line = READER_LINE,
) {
	expect(Math.abs(transcript.viewTopOf(line) - before)).toBeLessThanOrEqual(1);
}

describe("MessageList paging in a real layout", () => {
	it("holds the reader's content still when a page lands above it", async () => {
		const transcript = await renderTranscript({ pages: session(false) });
		await readToTop(transcript);
		const top = transcript.scroller.scrollTop;
		const before = transcript.viewTopOf(READER_LINE);

		await transcript.landPage();

		// At rest, the reserve the page went into was restored above it, and the
		// view moved down with the rows.
		expect(transcript.scroller.scrollTop).toBeGreaterThan(top);
		expectHeldStill(transcript, before);
		// The page is a short one: held still, the top of the history is still
		// within a screen above the reader, so the next page is asked for in the
		// commit this one landed in.
		expect(transcript.requests()).toBe(2);
	});

	// The test below passes just as well on a page that lands as a bubble of its
	// own; this keeps it covering the splice.
	it("splices a page cut inside a turn into the bubble at the top", async () => {
		const transcript = await renderTranscript({ pages: session(true) });
		await readToTop(transcript);

		await transcript.landPage();

		const bubble = screen
			.getByText("Earlier half.")
			.closest("[data-message-id]");
		expect(bubble).toContainElement(screen.getByText(READER_LINE));
	});

	it("holds the reader's content still when a page is spliced into the bubble at the top", async () => {
		const transcript = await renderTranscript({ pages: session(true) });
		await readToTop(transcript);
		const top = transcript.scroller.scrollTop;
		const before = transcript.viewTopOf(READER_LINE);

		await transcript.landPage();

		expect(transcript.scroller.scrollTop).toBeGreaterThan(top);
		expectHeldStill(transcript, before);
		expect(transcript.requests()).toBe(2);
	});

	// The page and the output can reach React between two renders and commit
	// together. Measured by the content's total height, the output would count
	// as history added above the reader and push them down by its height.
	it("holds the reader's content still when output lands at the end in the same commit as a page", async () => {
		const transcript = await renderTranscript({ pages: session(true) });
		await readToTop(transcript);
		const before = transcript.viewTopOf(READER_LINE);

		// Not a message: one the reader typed would take them to the tail.
		await transcript.landPage([
			write("Live output."),
			write("More live output."),
		]);

		expect(screen.getByText("More live output.")).toBeInTheDocument();
		expectHeldStill(transcript, before);
		expect(transcript.requests()).toBe(2);
	});
});

describe("MessageList paging ahead in a real layout", () => {
	/** How far the top of the loaded rows sits above the view's top edge. */
	function rowsAbove({ scroller }: RenderedTranscript): number {
		const first = scroller.querySelector("[data-message-id]");
		if (!first) throw new Error("no rows");
		return (
			scroller.getBoundingClientRect().top - first.getBoundingClientRect().top
		);
	}

	it("asks for an older page before the top of the loaded history is on screen", async () => {
		const transcript = await renderTranscript({ pages: session(false) });
		const { scroller } = transcript;
		expect(rowsAbove(transcript)).toBeGreaterThan(scroller.clientHeight);
		// Off the tail and at rest first, so that the scroll below changes no
		// state and commits nothing: what asks is the observer alone.
		await transcript.scrollTo(scroller.scrollTop - 200);
		await transcript.rest();
		expect(transcript.requests()).toBe(0);

		// Half a screen short of the top: nothing above the rows is in view yet.
		await transcript.scrollTo(
			scroller.scrollTop - rowsAbove(transcript) + scroller.clientHeight / 2,
		);

		expect(rowsAbove(transcript)).toBeGreaterThan(0);
		expect(transcript.requests()).toBe(1);
	});

	it("waits for a page that took the top more than a screen up until the reader reads on", async () => {
		const transcript = await renderTranscript({
			pages: [turns(1, 3), turns(30, 10), turns(20, 6)],
		});
		const { scroller } = transcript;
		await readToTop(transcript);

		await transcript.landPage();
		await transcript.rest();
		expect(rowsAbove(transcript)).toBeGreaterThan(scroller.clientHeight);
		expect(transcript.requests()).toBe(1);

		await transcript.scrollTo(
			scroller.scrollTop - rowsAbove(transcript) + scroller.clientHeight / 2,
		);
		expect(transcript.requests()).toBe(2);
	});
});

describe("MessageList mid-flick in a real layout", () => {
	// Nothing written while the reader's flick runs: on iOS that write is what
	// stopped the flick dead. The page has nowhere to go but up, past the top of
	// the track, until the view is at rest.
	it("holds the reader still without a write when a page taller than the reserve lands", async () => {
		const transcript = await renderTranscript({
			pages: [turns(1, 10), turns(20, 6)],
		});
		await readToTop(transcript);
		const line = "Answer 20.";
		transcript.press();
		const top = transcript.scroller.scrollTop;
		const before = transcript.viewTopOf(line);

		await transcript.landPage();

		expect(transcript.scroller.scrollTop).toBe(top);
		expectHeldStill(transcript, before, line);
		expect(transcript.trackTopOf("Question 1")).toBeLessThan(0);

		await transcript.release();

		expectHeldStill(transcript, before, line);
		expect(transcript.trackTopOf("Question 1")).toBeGreaterThanOrEqual(0);
	});
});

describe("the history reserve in a real layout", () => {
	const rows: Message[] = Array.from({ length: 6 }, (_, i) => ({
		id: `m${i}`,
		role: "assistant",
		status: "complete",
		createdAt: new Date(),
		parts: [{ type: "text", id: `text-${i}`, content: `Row ${i}. ${FILLER}` }],
	}));

	function List(props: {
		hasMoreHistory: boolean;
		historyError?: string | null;
		loadedHistoryPages?: number;
	}) {
		return (
			<div className="flex flex-col" style={{ height: 600 }}>
				<MessageList sessionId="reserve" messages={rows} {...props} />
			</div>
		);
	}

	// What a page failing, being retried and history running out each look like
	// lives inside the reserve, which only the list's own track gives a height —
	// so none of them can move the reader, even before the view is at rest.
	it("moves nothing as a page fails, is retried, and history runs out", async () => {
		const { container, rerender } = render(<List hasMoreHistory />);
		const scroller = container.querySelector<HTMLElement>(".overflow-y-auto");
		const first = container.querySelector<HTMLElement>("[data-message-id]");
		if (!scroller || !first) throw new Error("no transcript");
		scroller.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
		);
		const height = scroller.scrollHeight;
		const offset = first.offsetTop;
		const expectUnmoved = async () => {
			await act(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => resolve()),
					),
			);
			expect(scroller.scrollHeight).toBe(height);
			expect(first.offsetTop).toBe(offset);
		};

		rerender(<List hasMoreHistory historyError="Failed to load: gone" />);
		expect(screen.getByRole("alert")).toHaveTextContent("gone");
		await expectUnmoved();

		rerender(<List hasMoreHistory />);
		await expectUnmoved();

		rerender(<List hasMoreHistory={false} loadedHistoryPages={1} />);
		expect(screen.getByText("Beginning of conversation")).toBeInTheDocument();
		await expectUnmoved();

		window.dispatchEvent(
			new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }),
		);
	});
});

describe("MessageList holding the reader inside one long part", () => {
	/**
	 * Never loads (`stubChatHistoryRpc` never answers the read): its frame, not
	 * its pixels, is what takes up room.
	 */
	const IMAGE = "diagram.png";

	/**
	 * One answer several screens long — an image near its top, the reader's
	 * line well below it — above enough turns to scroll.
	 */
	const longAnswer = [
		...turns(1, 1),
		say("Explain it at length"),
		{
			type: "text",
			content: [
				"Here is the picture.",
				`![diagram](${IMAGE})`,
				...Array(6).fill(FILLER),
				READER_LINE,
				...Array(6).fill(FILLER),
			].join("\n\n"),
		},
		done,
		...turns(10, 3),
	];

	// What settles is the frame a diagram or an image is drawn in: it reaches
	// the list through the resize observer and through no commit at all.
	it("holds the reader still when something above them in the same part settles", async () => {
		const transcript = await renderTranscript({ pages: [longAnswer] });
		await transcript.scrollTo(
			transcript.scroller.scrollTop + transcript.viewTopOf(READER_LINE) - 100,
		);
		const frame = screen
			.getByRole("status", { name: "diagram" })
			.closest<HTMLElement>(".markdown-image");
		if (!frame) throw new Error("the image has no frame");
		// The part starts above the view, so holding the part still would hold
		// the image's growth against the reader.
		expect(transcript.viewTopOf("Here is the picture.")).toBeLessThan(0);
		const before = transcript.viewTopOf(READER_LINE);

		frame.style.height = `${frame.offsetHeight + 300}px`;
		await transcript.settle();

		expectHeldStill(transcript, before);
	});
});
