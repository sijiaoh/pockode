import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffSettingsStore } from "../../lib/diffSettingsStore";
import type { FullScreenContent } from "../../lib/fullScreen";
import { useWSStore } from "../../lib/wsStore";
import { FullScreenHost } from "./FullScreenHost";
import { Section, type SectionFullScreen } from "./ToolSection";

// jsdom does no layout: content is `height` tall, and a box with a max-height
// stops at the main budget's minimum of 8 lines (+ 6 while uncut).
function layOut(height: number) {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
		height,
	);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			if (this.hasAttribute("data-clamped")) return 128;
			return this.style.maxHeight ? Math.min(height, 224) : height;
		},
	);
}

function source(
	content: FullScreenContent,
	key = "run-1:result",
): SectionFullScreen {
	return {
		key,
		title: "Bash · pnpm test",
		subject: { kind: "text", text: "pnpm test --run" },
		content,
	};
}

const OUTPUT = source({ kind: "output", text: "line one\nline two" });

function Output({
	fullScreen = OUTPUT,
	label = "Output",
}: {
	fullScreen?: SectionFullScreen;
	label?: string;
}) {
	return (
		<Section
			label={label}
			noun="output"
			budget="main"
			clampFrom="end"
			copyText="line one\nline two"
			fullScreen={fullScreen}
		>
			<p>body text</p>
		</Section>
	);
}

const OPEN = { name: "Open output in full screen" };

// The diff itself is the library's to draw, and jsdom has no canvas for it.
vi.mock("../ui/DiffViewer", () => ({
	DiffViewer: ({ hunks }: { hunks: string[] }) => <pre>{hunks.join("")}</pre>,
}));

beforeEach(() => {
	useDiffSettingsStore.setState({ wrapLines: false });
	useWSStore.setState({ workDir: "/w" });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("full screen", () => {
	it("is offered in a block's header only once the block is cut", () => {
		layOut(100);
		const { unmount } = render(
			<FullScreenHost>
				<Output />
			</FullScreenHost>,
		);
		expect(screen.queryByRole("button", OPEN)).not.toBeInTheDocument();
		unmount();

		layOut(2000);
		render(
			<FullScreenHost>
				<Output />
			</FullScreenHost>,
		);
		expect(screen.getByRole("button", OPEN)).toHaveAttribute(
			"aria-haspopup",
			"dialog",
		);
	});

	it("is not offered outside a transcript, where there is nothing to open it in", () => {
		layOut(2000);
		render(<Output />);
		expect(screen.queryByRole("button", OPEN)).not.toBeInTheDocument();
	});

	it("shows the block under the tool's summary, and Escape hands focus back", async () => {
		const user = userEvent.setup();
		layOut(2000);
		render(
			<FullScreenHost>
				<Output />
			</FullScreenHost>,
		);
		const opener = screen.getByRole("button", OPEN);
		await user.click(opener);

		const dialog = screen.getByRole("dialog", { name: "Bash · pnpm test" });
		const content = within(dialog).getByRole("region", { name: "output" });
		expect(content).toHaveFocus();
		expect(content).toHaveTextContent("line one");
		expect(dialog).toHaveTextContent("2 lines");
		expect(
			within(dialog).getByRole("button", { name: "Copy output" }),
		).toBeInTheDocument();
		// Output wraps as it does in the transcript, until asked not to.
		expect(
			within(dialog).getByRole("button", { name: "Wrap long lines" }),
		).toHaveAttribute("aria-pressed", "true");

		// The subject opens onto the whole of it, outside the button so it can
		// be selected.
		const subject = within(dialog).getByRole("button", {
			name: "pnpm test --run",
		});
		expect(subject).toHaveAttribute("aria-expanded", "false");
		await user.click(subject);
		expect(subject).toHaveAttribute("aria-expanded", "true");
		const full = document.getElementById(
			subject.getAttribute("aria-controls") ?? "",
		);
		expect(full).toBeVisible();
		expect(full).toHaveTextContent("pnpm test --run");

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(opener).toHaveFocus();
	});

	it("opens content read from its end at its end", async () => {
		const user = userEvent.setup();
		layOut(2000);
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
			5000,
		);
		render(
			<FullScreenHost>
				<Output />
			</FullScreenHost>,
		);
		await user.click(screen.getByRole("button", OPEN));
		const content = screen.getByRole("region", { name: "output" });
		expect(content.scrollTop + content.clientHeight).toBe(5000);
	});

	it("carries on into the block that takes over the key, and closes when none does", async () => {
		const user = userEvent.setup();
		layOut(2000);
		const live = source({
			kind: "output",
			text: "so far",
			live: { droppedLines: 50 },
		});
		const { rerender } = render(
			<FullScreenHost>
				<Output label="Output so far" fullScreen={live} />
			</FullScreenHost>,
		);
		await user.click(screen.getByRole("button", OPEN));
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("Earlier output arrives with the result");

		// The live block unmounts and the result mounts in its place.
		rerender(
			<FullScreenHost>
				<div>
					<Output
						fullScreen={source({ kind: "output", text: "the whole result" })}
					/>
				</div>
			</FullScreenHost>,
		);
		expect(screen.getByRole("dialog")).toHaveTextContent("the whole result");
		expect(screen.getByRole("dialog")).not.toHaveTextContent(
			"Earlier output arrives",
		);

		rerender(<FullScreenHost>{null}</FullScreenHost>);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("shares the remembered wrap choice with the transcript's diffs", async () => {
		const user = userEvent.setup();
		layOut(2000);
		render(
			<FullScreenHost>
				<Output
					fullScreen={source({
						kind: "change",
						change: {
							kind: "edit",
							input: {
								file_path: "/w/a.ts",
								old_string: "a",
								new_string: "b",
							},
							patches: ["@@ -1 +1 @@\n-a\n+b"],
						},
					})}
				/>
			</FullScreenHost>,
		);
		await user.click(screen.getByRole("button", OPEN));
		const wrap = within(screen.getByRole("dialog")).getByRole("button", {
			name: "Wrap long lines",
		});
		expect(wrap).toHaveAttribute("aria-pressed", "false");
		await user.click(wrap);
		expect(useDiffSettingsStore.getState().wrapLines).toBe(true);
	});

	it("lists every file, and opening one closes the viewer first", async () => {
		const user = userEvent.setup();
		layOut(2000);
		const onOpenFile = vi.fn();
		const paths = Array.from({ length: 150 }, (_, i) => `/w/f${i}.ts`);
		render(
			<FullScreenHost>
				<Section
					label="Matches"
					budget="main"
					fullScreen={source({ kind: "files", paths, onOpenFile }, "g:result")}
				>
					<p>body text</p>
				</Section>
			</FullScreenHost>,
		);
		await user.click(
			screen.getByRole("button", { name: "Open matches in full screen" }),
		);
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent("150 files");
		expect(dialog).toHaveTextContent("f0.ts");

		await act(async () => {
			within(dialog).getAllByText("Open")[0].click();
		});
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(onOpenFile).toHaveBeenCalledWith("f0.ts");
	});

	describe("huge content", () => {
		const HUGE = Array.from({ length: 10_000 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const ROW = 16;
		const VIEW = 600;

		// Rows a line tall, the viewer's scroller a screen tall over all of them;
		// everything else as `layOut` has it.
		function layOutRows() {
			layOut(2000);
			const isScroller = (el: HTMLElement) =>
				el.getAttribute("aria-label") === "output" && el.tagName === "SECTION";
			vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
				function (this: HTMLElement) {
					if (this.hasAttribute("data-line")) return ROW;
					return isScroller(this) ? VIEW : 2000;
				},
			);
			vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
				function (this: HTMLElement) {
					if (isScroller(this)) return VIEW;
					if (this.hasAttribute("data-clamped")) return 128;
					return this.style.maxHeight ? 224 : 2000;
				},
			);
			// The viewer's scroller is positioned, so what is laid out in it is
			// placed against it.
			vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
				function (this: HTMLElement) {
					return this.parentElement?.closest("section") ?? null;
				},
			);
			vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
				function (this: HTMLElement) {
					return isScroller(this) ? 10_000 * ROW : 2000;
				},
			);
		}

		it("never unfolds in place, and opens full screen at its end", async () => {
			const user = userEvent.setup();
			layOutRows();
			render(
				<FullScreenHost>
					<Output
						fullScreen={source({ kind: "output", text: HUGE })}
						label="Output"
					/>
				</FullScreenHost>,
			);
			// The transcript draws a slice of the end, never the whole, and offers
			// no way to open it in place.
			expect(screen.getByText(/line 10000/)).toBeInTheDocument();
			expect(screen.queryByText(/^line 1$/m)).not.toBeInTheDocument();
			expect(screen.queryByText("body text")).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /^Show/ }),
			).not.toBeInTheDocument();
			const open = screen.getByRole("button", {
				name: "Open full output, 10,000 lines",
			});
			expect(open).toHaveTextContent("Open full output · 10,000 lines");

			await user.click(open);
			const content = screen.getByRole("region", { name: "output" });
			// Drawn by the window: the end is there, the start and most of the
			// rest are not.
			const drawn = content.querySelectorAll("[data-line]");
			expect(drawn.length).toBeGreaterThan(0);
			expect(drawn.length).toBeLessThan(200);
			expect(content).toHaveTextContent("line 10000");
			expect(content).not.toHaveTextContent(/line 1\b(?!\d)/);
		});

		it("keeps the header's Full screen button", () => {
			layOutRows();
			render(
				<FullScreenHost>
					<Output fullScreen={source({ kind: "output", text: HUGE })} />
				</FullScreenHost>,
			);
			expect(screen.getByRole("button", OPEN)).toBeInTheDocument();
		});
	});
});
