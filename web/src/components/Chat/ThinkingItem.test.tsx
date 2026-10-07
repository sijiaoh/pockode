import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thought } from "../../types/message";
import type { ClampView } from "../ui";
import ThinkingItem, { ThoughtBody, ThoughtScroller } from "./ThinkingItem";
import { TranscriptViewContext } from "./transcriptViewContext";

const thought = (extra: Partial<Thought> = {}): Thought => ({
	content: "",
	fullReasoning: "",
	redacted: false,
	...extra,
});

describe("ThinkingItem", () => {
	it("opens on the text, named as a sentence", async () => {
		const user = userEvent.setup();
		render(
			<ThinkingItem
				thoughts={[
					thought({ content: "Check the **sender**.", durationMs: 11_200 }),
				]}
			/>,
		);
		const row = screen.getByRole("button", { name: "Thought for 12 seconds" });
		expect(row).toHaveTextContent("Thought for 12s");
		expect(screen.queryByText("sender")).not.toBeInTheDocument();

		await user.click(row);
		expect(row).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("sender")).toBeInTheDocument();
	});

	it("labels Codex's raw reasoning only beside a summary", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<ThinkingItem
				thoughts={[thought({ content: "Summary.", fullReasoning: "Raw." })]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Thought" }));
		expect(screen.getByText("Full reasoning")).toBeInTheDocument();
		expect(screen.getByText("Raw.")).toBeInTheDocument();

		rerender(<ThinkingItem thoughts={[thought({ fullReasoning: "Raw." })]} />);
		expect(screen.getByText("Raw.")).toBeInTheDocument();
		expect(screen.queryByText("Full reasoning")).not.toBeInTheDocument();
	});

	it("keeps a redacted part's place in a merged body", async () => {
		const user = userEvent.setup();
		render(
			<ThinkingItem
				thoughts={[
					thought({ content: "First.", durationMs: 1000 }),
					thought({ redacted: true, durationMs: 1000 }),
					thought({ durationMs: 1000 }),
				]}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Thought for 3 seconds" }),
		);
		expect(screen.getByText("First.")).toBeInTheDocument();
		expect(
			screen.getByText("Hidden by the model provider."),
		).toBeInTheDocument();
	});

	it("says only Thought when a merged part was not measured", () => {
		render(
			<ThinkingItem
				thoughts={[
					thought({ content: "A.", durationMs: 1000 }),
					thought({ content: "B." }),
				]}
			/>,
		);
		expect(screen.getByRole("button", { name: "Thought" })).toBeInTheDocument();
	});

	// A row that opens on "there is nothing here" is a tap spent to learn
	// nothing, so the reason is in its name instead.
	it("draws redacted thinking as a row that is not a button", () => {
		render(
			<ThinkingItem
				thoughts={[thought({ redacted: true, durationMs: 75_000 })]}
			/>,
		);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByText("hidden")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Thought for 1 minute 15 seconds, content hidden by the model provider",
			),
		).toBeInTheDocument();
	});

	it("draws empty thinking without the chip", () => {
		render(<ThinkingItem thoughts={[thought({ durationMs: 400 })]} />);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.queryByText("hidden")).not.toBeInTheDocument();
		expect(
			screen.getByText("Thought for 1 second, no content shared"),
		).toBeInTheDocument();
	});
});

describe("ThoughtScroller", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps an opened Full reasoning's place in its own scroller, not the transcript's", async () => {
		const user = userEvent.setup();
		// jsdom does no layout: the reasoning is 2000px tall and cut at the
		// main budget's floor; the scroller's top is at 100 and the block's
		// box at 300, and opening it would push the box 50px down.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
			2000,
		);
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				if (this.hasAttribute("data-clamped")) return 128;
				return this.style.maxHeight ? 224 : 2000;
			},
		);
		const scroller = () => {
			const el = document.querySelector(".overflow-auto");
			if (!(el instanceof HTMLElement)) throw new Error("no scroller");
			return el;
		};
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const at = (top: number) => ({ top, bottom: top + 100 }) as DOMRect;
				if (this === scroller()) return at(100);
				if (this.id && this.parentElement?.querySelector("[aria-controls]")) {
					const open = !this.style.maxHeight;
					return at(300 + (open ? 50 : 0) - scroller().scrollTop);
				}
				return at(0);
			},
		);
		const transcript: ClampView = {
			top: () => 0,
			bottom: () => 600,
			scrollTop: () => 0,
			coveredAbove: () => 0,
			holdAt: vi.fn(),
		};
		render(
			<TranscriptViewContext value={transcript}>
				<ThoughtScroller className="">
					<ThoughtBody
						thought={thought({
							content: "Summary.",
							fullReasoning: "Raw reasoning.",
						})}
					/>
				</ThoughtScroller>
			</TranscriptViewContext>,
		);
		// jsdom keeps no scroll position of its own.
		let scrolled = 0;
		Object.defineProperty(scroller(), "scrollTop", {
			get: () => scrolled,
			set: (value: number) => {
				scrolled = value;
			},
		});

		await user.click(
			screen.getByRole("button", { name: "Show all of reasoning" }),
		);
		expect(scroller().scrollTop).toBe(50);
		expect(transcript.holdAt).not.toHaveBeenCalled();
	});
});
