import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type RenderedTranscript,
	renderTranscript,
} from "../../test/transcriptFixture";

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

/** Puts the reader at the top of the loaded history, which asks for a page. */
async function readToTop(transcript: RenderedTranscript) {
	await transcript.scrollTo(0);
	expect(transcript.requests()).toBe(1);
}

/**
 * The reader's line is where it was, to the pixel the anchor can promise: a
 * move under a pixel is not written at all (`DRIFT_TOLERANCE` in
 * `useTranscriptScroll`).
 */
function expectHeldStill(transcript: RenderedTranscript, before: number) {
	expect(
		Math.abs(transcript.viewTopOf(READER_LINE) - before),
	).toBeLessThanOrEqual(1);
}

describe("MessageList paging in a real layout", () => {
	it("holds the reader's content still when a page lands above it", async () => {
		const transcript = await renderTranscript({ pages: session(false) });
		await readToTop(transcript);
		const before = transcript.viewTopOf(READER_LINE);

		await transcript.landPage();

		expect(transcript.scroller.scrollTop).toBeGreaterThan(0);
		expectHeldStill(transcript, before);
		// Held still, the top of history went out of view with everything else
		// the page pushed up, so nothing asks for the next one.
		expect(transcript.requests()).toBe(1);
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
		const before = transcript.viewTopOf(READER_LINE);

		await transcript.landPage();

		expect(transcript.scroller.scrollTop).toBeGreaterThan(0);
		expectHeldStill(transcript, before);
		expect(transcript.requests()).toBe(1);
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
		expect(transcript.requests()).toBe(1);
	});
});

describe("MessageList holding the reader inside one long part", () => {
	/**
	 * Never loads: its frame, not its pixels, is what takes up room. Not a
	 * `data:` URL, which the Markdown renderer strips.
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
			.getByRole("img", { name: "diagram" })
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
