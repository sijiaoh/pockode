import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useMemo, useRef } from "react";
import { describe, expect, it } from "vitest";
import type { LiveThinking } from "../../lib/thinking";
import type { ClampView } from "../ui";
import { RowFrameContext } from "./rowExpansionContext";
import ThinkingItem from "./ThinkingItem";
import TurnTail from "./TurnTail";
import { TranscriptViewContext } from "./transcriptViewContext";
import { IDLE_TAIL, TurnTailContext } from "./turnTailContext";

const FILLER =
	"The agent weighs one option against another, and then against a third, at a length that wraps onto several lines at any width.";

/** Paragraphs `First line.`, filler…, and `Newest line <n>.` last. */
function reasoning(paragraphs: number, newest = 1): string {
	return [
		"First line.",
		...Array.from({ length: paragraphs }, () => FILLER),
		`Newest line ${newest}.`,
	].join("\n\n");
}

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Lets the resize observers report and React commit what they did. */
async function settle() {
	for (let i = 0; i < 3; i++) await act(nextFrame);
}

/**
 * A stand-in for the transcript: one box that scrolls, with something above
 * the content to scroll past, and the view the clamp keeps its place through.
 */
function Transcript({ children }: { children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	// Read leniently: a block mounted with the box takes its first look in a
	// layout effect, which runs before the box's own ref is attached.
	const view = useMemo<ClampView>(
		() => ({
			top: () => ref.current?.getBoundingClientRect().top ?? 0,
			bottom: () => ref.current?.getBoundingClientRect().bottom ?? 0,
			scrollTop: () => ref.current?.scrollTop ?? 0,
			coveredAbove: () => 0,
			holdAt: (target, offset) => {
				const el = ref.current;
				if (!el) return;
				el.scrollTop +=
					target.getBoundingClientRect().top -
					el.getBoundingClientRect().top -
					offset;
			},
		}),
		[],
	);
	return (
		<div
			ref={ref}
			data-testid="transcript"
			className="overflow-y-auto text-xs"
			style={{ height: 600, width: 360 }}
		>
			<div style={{ height: 1000 }} />
			<TranscriptViewContext value={view}>{children}</TranscriptViewContext>
		</div>
	);
}

/** Every element inside `root` that would take a vertical drag for itself. */
function verticalScrollers(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>("*")].filter((el) =>
		["auto", "scroll"].includes(getComputedStyle(el).overflowY),
	);
}

/** Whether any of `text`'s element shows inside `box`, and inside the transcript. */
function seen(text: string, box: HTMLElement): boolean {
	const at = screen.getByText(text, { selector: "p" }).getBoundingClientRect();
	const clip = box.getBoundingClientRect();
	const view = screen.getByTestId("transcript").getBoundingClientRect();
	return (
		at.bottom > Math.max(clip.top, view.top) &&
		at.top < Math.min(clip.bottom, view.bottom)
	);
}

/** The clamp box a text is drawn in. */
function boxOf(text: string): HTMLElement {
	const box = screen
		.getByText(text, { selector: "p" })
		.closest<HTMLElement>("[id]");
	if (!box) throw new Error(`no box around ${text}`);
	return box;
}

describe("a thought in a real layout", () => {
	it("is cut at its start and opened in place, never scrolled in a box of its own", async () => {
		const user = userEvent.setup();
		render(
			<Transcript>
				<ThinkingItem
					thoughts={[
						{
							id: "t",
							content: reasoning(20),
							fullReasoning: "",
							redacted: false,
						},
					]}
				/>
			</Transcript>,
		);
		const transcript = screen.getByTestId("transcript");
		await user.click(screen.getByRole("button", { name: "Thought" }));
		transcript.scrollTop = 1000;
		await settle();

		expect(verticalScrollers(transcript)).toEqual([]);
		const box = boxOf("First line.");
		expect(seen("First line.", box)).toBe(true);
		expect(seen("Newest line 1.", box)).toBe(false);

		await user.click(
			screen.getByRole("button", { name: "Show all of thinking" }),
		);
		await settle();
		expect(box.clientHeight).toBe(box.scrollHeight);
	});

	it("shows its newest text while it is live, and follows it as it grows", async () => {
		const user = userEvent.setup();
		const live = (paragraphs: number, newest: number): LiveThinking => ({
			content: reasoning(paragraphs, newest),
			fullReasoning: "",
			joinedLate: false,
			expanded: true,
		});
		const tail = (thinking: LiveThinking) => (
			<Transcript>
				<TurnTailContext value={{ ...IDLE_TAIL, phase: "running", thinking }}>
					<TurnTail writing placeholder={false} />
				</TurnTailContext>
			</Transcript>
		);
		const { rerender } = render(tail(live(20, 1)));
		const transcript = screen.getByTestId("transcript");
		transcript.scrollTop = transcript.scrollHeight;
		await settle();

		expect(verticalScrollers(transcript)).toEqual([]);
		const box = boxOf("Newest line 1.");
		expect(seen("Newest line 1.", box)).toBe(true);
		expect(seen("First line.", box)).toBe(false);

		// Opened, the block grows with what arrives, and the reader is held at
		// its newest line rather than left behind at where it used to end.
		await user.click(
			screen.getByRole("button", { name: "Show all of thinking" }),
		);
		await settle();
		transcript.scrollTop = transcript.scrollHeight;
		await settle();
		rerender(tail(live(30, 2)));
		await settle();
		expect(seen("Newest line 2.", box)).toBe(true);
	});

	// No bar of its own is over a thought's body, but a subagent's open row may
	// be: the header pins under whatever is pinned there, never beneath it.
	// Bare at the top, as a reply's lone thought is drawn — a body clipped as a
	// scroller would hold the header inside it — and framed in a row's list, as
	// a subagent's is among its calls.
	it.each([
		["at the transcript's top", false],
		["under the bar of the row it is in", true],
	])("pins an opened Full reasoning's header %s", async (_, inRow) => {
		const user = userEvent.setup();
		const item = (
			<ThinkingItem
				thoughts={[
					{
						id: "t",
						content: "Summary.",
						fullReasoning: reasoning(40),
						redacted: false,
					},
				]}
			/>
		);
		render(
			<Transcript>
				{inRow ? (
					<div>
						<div
							data-testid="bar"
							className="row-bar"
							style={{ height: "var(--row-height)" }}
						>
							Subagent
						</div>
						<div>{item}</div>
					</div>
				) : (
					<RowFrameContext value={false}>{item}</RowFrameContext>
				)}
			</Transcript>,
		);
		await user.click(screen.getByRole("button", { name: "Thought" }));
		await user.click(
			screen.getByRole("button", { name: "Show all of reasoning" }),
		);
		const transcript = screen.getByTestId("transcript");
		const header = screen.getByText("Full reasoning").closest("div.pb-1");
		if (!(header instanceof HTMLElement)) throw new Error("no header");
		// Well into the opened reasoning, past where the header was drawn.
		transcript.scrollTop =
			header.getBoundingClientRect().top -
			transcript.getBoundingClientRect().top +
			transcript.scrollTop +
			600;
		await settle();

		const pinnedAt = inRow
			? screen.getByTestId("bar").getBoundingClientRect().bottom
			: transcript.getBoundingClientRect().top;
		expect(header.getBoundingClientRect().top).toBeCloseTo(pinnedAt, 0);
	});
});
