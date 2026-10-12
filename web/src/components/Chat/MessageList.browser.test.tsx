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
 * The reader's line is where it was, to the pixel the anchor can promise: it
 * is restored from `offsetTop`, a whole number, and a move under a pixel is not
 * written at all (`DRIFT_TOLERANCE` in `useTranscriptScroll`).
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

	// What the expected failure below stands on: `it.fails` passes on any throw,
	// so this proves the page really is spliced, and the fixture really lands it.
	it("splices a page cut inside a turn into the bubble at the top", async () => {
		const transcript = await renderTranscript({ pages: session(true) });
		await readToTop(transcript);

		await transcript.landPage();

		const bubble = screen
			.getByText("Earlier half.")
			.closest("[data-message-id]");
		expect(bubble).toContainElement(screen.getByText(READER_LINE));
	});

	// TODO: Drop `.fails` once paging survives the splice; this is the bug it
	// reproduces. The page's last records are the first half of the bubble at the
	// top, so the two are spliced into one bubble that keeps its id, and the
	// parts inside it are rebuilt. The prose the reader is anchored on is keyed
	// by its index, which the older parts shift (`text-2` becomes `text-4`), so
	// its wrapper is unmounted and the anchor leaves the DOM; that alone is what
	// loses it here. (The call list above it remounts too — it now opens on an
	// older call — which would close a row the reader had opened.) A fresh anchor
	// is then taken at the top of the view, the view stays at 0 with the reader's
	// line pushed down by the whole older half, and the sentinel still in view
	// asks for the next page in the same commit.
	it.fails("holds the reader's content still when a page is spliced into the bubble at the top", async () => {
		const transcript = await renderTranscript({ pages: session(true) });
		await readToTop(transcript);
		const before = transcript.viewTopOf(READER_LINE);

		await transcript.landPage();

		expect(transcript.scroller.scrollTop).toBeGreaterThan(0);
		expectHeldStill(transcript, before);
		expect(transcript.requests()).toBe(1);
	});
});
