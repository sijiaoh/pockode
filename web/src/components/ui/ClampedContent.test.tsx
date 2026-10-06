import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClampedContent,
	type ClampHandle,
	type ClampView,
} from "./ClampedContent";

const LINE = 16;
/** The supporting budget, 8 lines. */
const BUDGET = 8 * LINE;
const TOLERANCE = 6 * LINE;

// jsdom does no layout, so how tall things are has to be said: the content is
// `contentHeight` tall, and the box stops where its max-height would stop it —
// at the budget while cut, at budget + tolerance while not, nowhere while open.
function layOut(contentHeight: number, budget = BUDGET) {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
		contentHeight,
	);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			if (this.hasAttribute("data-clamped")) return budget;
			if (!this.style.maxHeight) return contentHeight;
			return Math.min(contentHeight, budget + TOLERANCE);
		},
	);
}

function setCoarsePointer(coarse: boolean) {
	vi.spyOn(window, "matchMedia").mockImplementation(
		(query: string) =>
			({
				matches: coarse && query === "(pointer: coarse)",
				media: query,
				addEventListener: () => {},
				removeEventListener: () => {},
			}) as unknown as MediaQueryList,
	);
}

function box(): HTMLElement {
	const el = screen.getByText("body text").parentElement?.parentElement;
	if (!el) throw new Error("clamp box not found");
	return el;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ClampedContent", () => {
	it("leaves content that fits alone", () => {
		layOut(100);
		render(
			<ClampedContent fullScreenTitle="notes.md">
				<p>body text</p>
			</ClampedContent>,
		);

		expect(box()).not.toHaveAttribute("data-clamped");
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	// A button that reveals a few lines costs more than the lines do.
	it("shows content less than six lines over its budget whole", () => {
		layOut(BUDGET + 5 * LINE);
		render(
			<ClampedContent>
				<p>body text</p>
			</ClampedContent>,
		);

		expect(box()).not.toHaveAttribute("data-clamped");
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("cuts content more than six lines over its budget", () => {
		layOut(BUDGET + 7 * LINE);
		render(
			<ClampedContent count={{ noun: "line", total: 15 }}>
				<p>body text</p>
			</ClampedContent>,
		);

		expect(box()).toHaveAttribute("data-clamped");
		expect(screen.getByRole("button")).toHaveTextContent("Show 7 more lines");
	});

	// A scroll box here would take the drag a phone meant for the transcript;
	// the content is cut instead, and opened where it stands.
	it("cuts long content and opens and closes it in place, without a scroller", async () => {
		const user = userEvent.setup();
		layOut(2000);
		render(
			<ClampedContent count={{ noun: "line", total: 125 }} name="output">
				<p>body text</p>
			</ClampedContent>,
		);

		expect(box()).toHaveClass("overflow-y-hidden");
		expect(box().style.maxHeight).toBe("var(--clamp-budget)");
		const button = screen.getByRole("button", {
			name: "Show 117 more lines of output",
		});
		expect(button).toHaveTextContent("Show 117 more lines");
		expect(button).toHaveAttribute("aria-expanded", "false");
		expect(button).toHaveAttribute("aria-controls", box().id);

		await user.click(button);
		expect(box()).not.toHaveAttribute("data-clamped");
		expect(box().style.maxHeight).toBe("");
		expect(button).toHaveAccessibleName("Show less of output");
		expect(button).toHaveAttribute("aria-expanded", "true");

		await user.click(button);
		expect(box()).toHaveAttribute("data-clamped");
		expect(button).toHaveAccessibleName("Show 117 more lines of output");
	});

	it("keeps the tail in view, with its button above, when read from the end", () => {
		layOut(2000);
		render(
			<ClampedContent from="end" count={{ noun: "line", total: 125 }}>
				<p>body text</p>
			</ClampedContent>,
		);

		expect(box()).toHaveClass("justify-end");
		const button = screen.getByRole("button");
		expect(button).toHaveTextContent("Show 117 earlier lines");
		expect(
			button.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("counts a list of files in files", () => {
		layOut(1000);
		render(
			<ClampedContent count={{ noun: "file", total: 100 }}>
				<p>body text</p>
			</ClampedContent>,
		);

		expect(screen.getByRole("button")).toHaveTextContent("Show 87 more files");
	});

	it("offers content with no unit to count in whole", () => {
		layOut(2000);
		render(
			<ClampedContent>
				<p>body text</p>
			</ClampedContent>,
		);

		expect(screen.getByRole("button")).toHaveTextContent("Show all");
	});

	// One minified JSON answer is one line; "Show 1 more line" over a screenful
	// would say nothing about what is hidden.
	it("offers lines that each wrap onto several rows whole", () => {
		layOut(2000);
		render(
			<ClampedContent count={{ noun: "line", total: 3 }}>
				<p>body text</p>
			</ClampedContent>,
		);

		expect(screen.getByRole("button")).toHaveTextContent("Show all");
	});

	// A change drawn without a patch has no rows to count, and "Show 1 more
	// line" over a whole block would be a lie.
	it("offers content that counted nothing whole", () => {
		layOut(2000);
		render(
			<ClampedContent count={{ noun: "line", total: 0 }}>
				<p>body text</p>
			</ClampedContent>,
		);

		expect(screen.getByRole("button")).toHaveTextContent("Show all");
	});

	describe("budget", () => {
		it("gives supporting content eight lines", () => {
			layOut(100);
			render(
				<ClampedContent budget="supporting">
					<p>body text</p>
				</ClampedContent>,
			);

			expect(box().style.getPropertyValue("--clamp-budget")).toBe("8rem");
		});

		// A share of the transcript and not of the window, between a floor and
		// a ceiling that is lower where the transcript is a phone's.
		it.each([
			[true, "20rem"],
			[false, "30rem"],
		])("gives main content a share of the transcript (coarse pointer: %s)", (coarse, cap) => {
			setCoarsePointer(coarse);
			layOut(100);
			render(
				<ClampedContent budget="main">
					<p>body text</p>
				</ClampedContent>,
			);

			expect(box().style.getPropertyValue("--clamp-budget")).toBe(
				`clamp(8rem, calc(var(--transcript-height, 100svh) * 0.45), ${cap})`,
			);
		});
	});

	it("opens when keyboard focus enters the part that is cut", () => {
		layOut(2000);
		render(
			<ClampedContent>
				<p>body text</p>
				<a href="#x">link</a>
			</ClampedContent>,
		);

		const link = screen.getByText("link");
		// jsdom does not implement `:focus-visible`; this focus is a keyboard's.
		vi.spyOn(link, "matches").mockReturnValue(true);
		act(() => link.focus());
		expect(box()).not.toHaveAttribute("data-clamped");
	});

	// docs/tool-call-ui.md#keeping-the-readers-place. The view's top is at 0
	// and a pinned title covers its first 44px; the box starts at `at.box`.
	describe("keeping the reader's place", () => {
		const COVERED = 44;
		const VIEW_BOTTOM = 600;
		const at = { box: 300, button: 280, header: 0 };
		const header = document.createElement("div");
		let content = 2000;
		let scrolled = 0;

		/** The reader scrolling the view, which carries the block with it. */
		function scroll(by: number) {
			scrolled += by;
			at.box -= by;
		}

		function fakeView() {
			return {
				top: () => 0,
				bottom: () => VIEW_BOTTOM,
				scrollTop: () => scrolled,
				coveredAbove: () => COVERED,
				holdAt: vi.fn<ClampView["holdAt"]>(),
			};
		}

		function rect(top: number, height: number): DOMRect {
			return { top, bottom: top + height, height } as DOMRect;
		}

		// The clamp's box and its button are drawn where `at` says; the box
		// as tall as `layOut` makes it.
		function layOutOnScreen() {
			vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
				() => content,
			);
			vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
				function (this: HTMLElement) {
					if (this.hasAttribute("data-clamped")) return BUDGET;
					if (!this.style.maxHeight) return content;
					return Math.min(content, BUDGET + TOLERANCE);
				},
			);
			vi.spyOn(
				HTMLElement.prototype,
				"getBoundingClientRect",
			).mockImplementation(function (this: HTMLElement) {
				if (this.hasAttribute("aria-controls")) return rect(at.button, 24);
				if (this === header) return rect(at.header, 24);
				if (this.id && this === box()) return rect(at.box, this.clientHeight);
				return rect(0, 0);
			});
		}

		afterEach(() => {
			at.box = 300;
			at.button = 280;
			at.header = 0;
			content = 2000;
			scrolled = 0;
		});

		it("keeps the top of content cut at its end where it was when opened", async () => {
			const user = userEvent.setup();
			layOutOnScreen();
			const view = fakeView();
			render(
				<ClampedContent view={view}>
					<p>body text</p>
				</ClampedContent>,
			);

			await user.click(screen.getByText("Show all"));
			expect(view.holdAt).toHaveBeenCalledWith(box(), 300);
		});

		it("grows content read from its tail upward, its bottom held", async () => {
			const user = userEvent.setup();
			layOutOnScreen();
			const view = fakeView();
			render(
				<ClampedContent view={view} from="end">
					<p>body text</p>
				</ClampedContent>,
			);

			await user.click(screen.getByText("Show all"));
			// The bottom was at 300 + 128; the open box is 2000 tall.
			expect(view.holdAt).toHaveBeenCalledWith(box(), 300 + BUDGET - 2000);
		});

		it("holds the button where it was pressed when closing", async () => {
			const user = userEvent.setup();
			layOutOnScreen();
			const view = fakeView();
			render(
				<ClampedContent view={view} from="end">
					<p>body text</p>
				</ClampedContent>,
			);
			await user.click(screen.getByText("Show all"));
			view.holdAt.mockClear();

			const less = screen.getByText("Show less");
			await user.click(less);
			expect(view.holdAt).toHaveBeenCalledWith(less, 280);
		});

		it("holds the button below content cut at its end when closing", async () => {
			const user = userEvent.setup();
			layOutOnScreen();
			const view = fakeView();
			render(
				<ClampedContent view={view}>
					<p>body text</p>
				</ClampedContent>,
			);
			await user.click(screen.getByText("Show all"));
			view.holdAt.mockClear();

			at.button = 500;
			const less = screen.getByText("Show less");
			await user.click(less);
			expect(view.holdAt).toHaveBeenCalledWith(less, 500);
		});

		// Pressed where nobody can see it — under the pinned title, by a screen
		// reader — the button's edge says nothing about where the reader is.
		it("lands what it heads just under the pinned title when the button is out of sight", async () => {
			const user = userEvent.setup();
			layOutOnScreen();
			const view = fakeView();
			const landingRef = { current: document.createElement("div") };
			render(
				<ClampedContent view={view} from="end" landingRef={landingRef}>
					<p>body text</p>
				</ClampedContent>,
			);
			await user.click(screen.getByText("Show all"));
			view.holdAt.mockClear();

			at.button = 20;
			act(() => screen.getByText("Show less").click());
			expect(view.holdAt).toHaveBeenCalledWith(landingRef.current, COVERED);
		});

		// The header is pinned under the title while the block is open, and
		// what it covers is as hidden as what the title does.
		it("counts a button under the pinned header as out of sight", async () => {
			const user = userEvent.setup();
			layOutOnScreen();
			const view = fakeView();
			render(
				<ClampedContent view={view} from="end" landingRef={{ current: header }}>
					<p>body text</p>
				</ClampedContent>,
			);
			await user.click(screen.getByText("Show all"));
			view.holdAt.mockClear();

			at.header = COVERED;
			at.button = COVERED;
			act(() => screen.getByText("Show less").click());
			expect(view.holdAt).toHaveBeenCalledWith(header, COVERED);
		});

		// The header on screen and not pinned: bringing it up to the title
		// would move the reader for nothing.
		it("leaves a header in sight where it is when the button is out of sight", async () => {
			const user = userEvent.setup();
			layOutOnScreen();
			const view = fakeView();
			render(
				<ClampedContent view={view} landingRef={{ current: header }}>
					<p>body text</p>
				</ClampedContent>,
			);
			await user.click(screen.getByText("Show all"));
			view.holdAt.mockClear();

			at.header = 300;
			at.button = VIEW_BOTTOM + 900;
			act(() => screen.getByText("Show less").click());
			expect(view.holdAt).toHaveBeenCalledWith(header, 300);
		});

		it("closes from its handle as from its button, focus kept on the block", async () => {
			const user = userEvent.setup();
			layOutOnScreen();
			const view = fakeView();
			const handle = createRef<ClampHandle>();
			const onOpenChange = vi.fn();
			render(
				<ClampedContent
					view={view}
					landingRef={{ current: header }}
					ref={handle}
					onOpenChange={onOpenChange}
				>
					<p>body text</p>
				</ClampedContent>,
			);
			await user.click(screen.getByText("Show all"));
			expect(onOpenChange).toHaveBeenLastCalledWith(true);
			view.holdAt.mockClear();

			// Pressed far down the open block: the button is below the view.
			at.header = COVERED;
			at.button = VIEW_BOTTOM + 900;
			(document.activeElement as HTMLElement).blur();
			act(() => handle.current?.close());
			expect(onOpenChange).toHaveBeenLastCalledWith(false);
			expect(box()).toHaveAttribute("data-clamped");
			expect(view.holdAt).toHaveBeenCalledWith(header, COVERED);
			expect(screen.getByRole("button", { name: "Show all" })).toHaveFocus();
		});

		it("holds the bottom when keyboard focus opens content read from its tail", () => {
			layOutOnScreen();
			const view = fakeView();
			render(
				<ClampedContent view={view} from="end">
					<a href="#x">link</a>
					<p>body text</p>
				</ClampedContent>,
			);

			const link = screen.getByText("link");
			vi.spyOn(link, "matches").mockReturnValue(true);
			act(() => link.focus());
			expect(view.holdAt).toHaveBeenCalledWith(box(), 300 + BUDGET - 2000);
		});

		describe("following live output", () => {
			let resized: (() => void)[] = [];

			function followLayout() {
				resized = [];
				vi.stubGlobal(
					"ResizeObserver",
					class {
						constructor(callback: () => void) {
							resized.push(callback);
						}
						observe() {}
						disconnect() {}
					},
				);
				layOutOnScreen();
			}

			function grow(to: number) {
				content = to;
				act(() => {
					for (const callback of resized) callback();
				});
			}

			afterEach(() => {
				vi.unstubAllGlobals();
			});

			it("keeps the bottom in sight while it grows", () => {
				followLayout();
				content = 50;
				at.box = 500;
				const view = fakeView();
				render(
					<ClampedContent view={view} from="end" follow>
						<p>body text</p>
					</ClampedContent>,
				);

				// Still inside the view: nothing to do.
				grow(80);
				expect(view.holdAt).not.toHaveBeenCalled();
				// Past its bottom edge: the bottom stays at 580, growing upward.
				grow(150);
				expect(view.holdAt).toHaveBeenCalledWith(box(), 580 - 150);
			});

			it("stops following once the reader scrolls up away from it", () => {
				followLayout();
				content = 50;
				at.box = 500;
				const view = fakeView();
				render(
					<ClampedContent view={view} from="end" follow>
						<p>body text</p>
					</ClampedContent>,
				);

				scroll(-40);
				grow(150);
				expect(view.holdAt).not.toHaveBeenCalled();
			});

			it("follows again once the reader comes back down to it", () => {
				followLayout();
				content = 50;
				at.box = 500;
				const view = fakeView();
				render(
					<ClampedContent view={view} from="end" follow>
						<p>body text</p>
					</ClampedContent>,
				);
				scroll(-40);
				grow(60);

				// Back down, the bottom at 560 and in sight.
				scroll(40);
				grow(150);
				expect(view.holdAt).toHaveBeenCalledWith(box(), 560 - 150);
			});

			// The button that appears above a block once it is cut pushes it
			// down without anyone scrolling.
			it("does not take the block moving on its own for the reader leaving", () => {
				followLayout();
				content = 50;
				at.box = 500;
				const view = fakeView();
				render(
					<ClampedContent view={view} from="end" follow>
						<p>body text</p>
					</ClampedContent>,
				);

				at.box = 524;
				grow(150);
				expect(view.holdAt).toHaveBeenCalledWith(box(), 550 - 150);
			});
		});
	});

	it("offers a long file a screen of its own", async () => {
		const user = userEvent.setup();
		layOut(2000);
		render(
			<ClampedContent fullScreenTitle="Read · src/main.ts">
				<p>body text</p>
			</ClampedContent>,
		);

		await user.click(screen.getByText("Full screen"));
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("Read · src/main.ts");
		expect(dialog).toHaveTextContent("body text");

		// Still on offer after the content has been opened in place: being
		// readable inline does not make a whole file comfortable to read there.
		await user.click(screen.getByLabelText("Close"));
		await user.click(screen.getByText("Show all"));
		expect(screen.getByText("Full screen")).toBeInTheDocument();
	});
});
