import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FullScreenContent } from "../../lib/fullScreen";
import { useWSStore } from "../../lib/wsStore";
import { diffSegments } from "./FullScreenFind";
import { FullScreenViewer } from "./FullScreenViewer";

const ROW = 16;
const VIEW = 600;

/**
 * jsdom does no layout: the viewer's scroller is a screen tall, each drawn
 * row a line tall, and everything is laid out in the scroller.
 */
function layOut(lineCount: number) {
	const isScroller = (el: HTMLElement) => el.tagName === "SECTION";
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			if (this.hasAttribute("data-line")) return ROW;
			return isScroller(this) ? VIEW : 0;
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return isScroller(this) ? VIEW : 0;
		},
	);
	vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
		function (this: HTMLElement) {
			return this.parentElement?.closest("section") ?? null;
		},
	);
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return isScroller(this) ? lineCount * ROW : 0;
		},
	);
}

/** The Custom Highlight API, which jsdom lacks: what is painted, by name. */
function stubHighlights(): Map<string, Set<Range>> {
	const registry = new Map<string, Set<Range>>();
	vi.stubGlobal(
		"Highlight",
		class extends Set<Range> {
			constructor(...ranges: Range[]) {
				super(ranges);
			}
		},
	);
	vi.stubGlobal("CSS", { highlights: registry });
	return registry;
}

function View({
	content,
	from = "start",
	onClose = () => {},
}: {
	content: FullScreenContent;
	from?: "start" | "end";
	onClose?: () => void;
}) {
	return (
		<FullScreenViewer
			source={{
				title: "Bash · pnpm test",
				label: "Output",
				noun: "output",
				from,
				content,
			}}
			onClose={onClose}
			closeThen={(after) => after()}
			afterCloseRef={{ current: null }}
		/>
	);
}

const LINES = Array.from({ length: 10_000 }, (_, i) => `line ${i + 1}`).join(
	"\n",
);

beforeEach(() => {
	useWSStore.setState({ workDir: "/w" });
	// jsdom lays nothing out, and has no layout methods on a range at all.
	Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	// @ts-expect-error: put back as jsdom has it, without one
	delete Range.prototype.getBoundingClientRect;
});

async function openFind(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "Find" }));
	return screen.getByRole("textbox", { name: "Find in output" });
}

describe("find in the full screen viewer", () => {
	it("counts every match, steps through them both ways and wraps around", async () => {
		const user = userEvent.setup();
		layOut(3);
		render(
			<View content={{ kind: "output", text: "a fail\nok\nFAIL b fail" }} />,
		);
		const find = screen.getByRole("button", { name: "Find" });
		expect(find).toHaveAttribute("aria-expanded", "false");

		const input = await openFind(user);
		expect(input).toHaveFocus();
		expect(find).toHaveAttribute("aria-expanded", "true");
		const next = screen.getByRole("button", { name: "Next match" });
		expect(next).toBeDisabled();

		await user.type(input, "fail");
		expect(await screen.findByText("1 / 3")).toBeInTheDocument();
		expect(screen.getByText("1 of 3 matches")).toBeInTheDocument();

		await user.keyboard("{Enter}");
		expect(screen.getByText("2 / 3")).toBeInTheDocument();
		await user.click(next);
		await user.click(next);
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
		await user.keyboard("{Shift>}{Enter}{/Shift}");
		expect(screen.getByText("3 / 3")).toBeInTheDocument();
		expect(screen.getByText("3 of 3 matches")).toBeInTheDocument();
		// Stepping leaves the reader typing.
		expect(input).toHaveFocus();
	});

	it("searches at once on Enter pressed before typing settles", async () => {
		const user = userEvent.setup();
		layOut(3);
		render(
			<View content={{ kind: "output", text: "a fail\nok\nFAIL b fail" }} />,
		);
		await user.type(await openFind(user), "fail{Enter}");
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
		// The settled search does not take the match back.
		await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
	});

	it("says when nothing matches, and offers no step", async () => {
		const user = userEvent.setup();
		layOut(1);
		render(<View content={{ kind: "output", text: "all good" }} />);
		await user.type(await openFind(user), "fail");
		expect(await screen.findAllByText("No matches")).toHaveLength(2);
		expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Previous match" }),
		).toBeDisabled();
	});

	it("highlights the matches drawn, the current one apart", async () => {
		const user = userEvent.setup();
		const painted = stubHighlights();
		layOut(2);
		render(<View content={{ kind: "output", text: "a fail\nfail b" }} />);
		await user.type(await openFind(user), "fail");
		await screen.findByText("1 / 2");

		const text = (name: string) =>
			[...(painted.get(name) ?? [])].map((range) => range.toString());
		expect(text("find-current")).toEqual(["fail"]);
		expect(text("find-match")).toEqual(["fail"]);
		const [current] = painted.get("find-current") ?? [];
		expect(current.startContainer.textContent).toBe("a fail");

		// Closing find takes the highlights away with it.
		await user.click(screen.getByRole("button", { name: "Close find" }));
		expect(painted.has("find-current")).toBe(false);
	});

	it("highlights lines that end in a carriage return", async () => {
		const user = userEvent.setup();
		const painted = stubHighlights();
		for (const content of [
			{ kind: "output", text: "a fail\r\nb" },
			{ kind: "code", text: "a fail\r\nb" },
		] satisfies FullScreenContent[]) {
			layOut(2);
			const { unmount } = render(<View content={content} />);
			await user.type(await openFind(user), "fail");
			await screen.findByText("1 / 1");
			expect(
				[...(painted.get("find-current") ?? [])].map((r) => r.toString()),
			).toEqual(["fail"]);
			unmount();
		}
	});

	it("finds lines that are not drawn, and brings the current one into view", async () => {
		const user = userEvent.setup();
		const painted = stubHighlights();
		layOut(10_000);
		render(<View content={{ kind: "output", text: LINES }} from="end" />);
		const content = screen.getByRole("region", { name: "output" });
		expect(content).not.toHaveTextContent(/line 1234(?!\d)/);

		// Counted over every line, drawn or not: 99, 990–999, 9900–9999.
		await user.type(await openFind(user), "line 99");
		expect(await screen.findByText(/ \/ 111$/)).toBeInTheDocument();

		await user.clear(screen.getByRole("textbox"));
		await user.type(screen.getByRole("textbox"), "line 1234");
		// From the end there is nothing after the reader's place, so find wraps
		// to the one match, far above what is drawn.
		await screen.findByText("1 / 1");
		act(() => {
			fireEvent.scroll(content);
		});
		await waitFor(() => expect(content).toHaveTextContent(/line 1234(?!\d)/));
		await waitFor(() =>
			expect(
				[...(painted.get("find-current") ?? [])].map((r) => r.toString()),
			).toEqual(["line 1234"]),
		);
	});

	it("searches rendered Markdown's text", async () => {
		const user = userEvent.setup();
		render(
			<View
				content={{
					kind: "markdown",
					markdown: "# Plan\n\nRun **the** tests.\n\n- run them again",
				}}
			/>,
		);
		await user.type(await openFind(user), "run");
		expect(await screen.findByText("1 / 2")).toBeInTheDocument();
		await user.clear(screen.getByRole("textbox"));
		// Rendered, the bold's asterisks are gone.
		await user.type(screen.getByRole("textbox"), "run the tests");
		expect(await screen.findByText("1 / 1")).toBeInTheDocument();
	});

	describe("Escape", () => {
		it("closes find first, then the viewer", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			layOut(1);
			render(
				<View content={{ kind: "output", text: "x" }} onClose={onClose} />,
			);
			await openFind(user);

			await user.keyboard("{Escape}");
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Find" })).toHaveFocus();
			expect(onClose).not.toHaveBeenCalled();

			await user.keyboard("{Escape}");
			expect(onClose).toHaveBeenCalled();
		});

		it("closes find from the content too, where focus lands after a tap", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			layOut(1);
			render(
				<View content={{ kind: "output", text: "x" }} onClose={onClose} />,
			);
			await openFind(user);
			screen.getByRole("region", { name: "output" }).focus();
			await user.keyboard("{Escape}");
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});

		it("only cancels a composition, closing neither find nor the viewer", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			layOut(1);
			render(
				<View content={{ kind: "output", text: "x" }} onClose={onClose} />,
			);
			const input = await openFind(user);
			fireEvent.keyDown(input, { key: "Escape", isComposing: true });
			fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
			expect(input).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	it("does not step on the Enter that commits a composition", async () => {
		const user = userEvent.setup();
		layOut(2);
		render(<View content={{ kind: "output", text: "fail\nfail" }} />);
		const input = await openFind(user);
		await user.type(input, "fail");
		await screen.findByText("1 / 2");
		fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });
		expect(screen.getByText("1 / 2")).toBeInTheDocument();
	});

	it("keeps to the same match while live output drops its head and becomes the result", async () => {
		const user = userEvent.setup();
		const painted = stubHighlights();
		layOut(200);
		// Live output's last 200 lines, numbered in the whole, from `from`.
		const window = (from: number, to: number) =>
			Array.from({ length: to - from }, (_, i) => {
				const n = from + i;
				return n === 5 || n === 200 ? `out ${n} needle` : `out ${n}`;
			}).join("\n");
		const live = (dropped: number, to: number): FullScreenContent => ({
			kind: "output",
			text: window(dropped, to),
			live: { droppedLines: dropped },
		});
		const { rerender } = render(<View content={live(0, 200)} />);
		await user.type(await openFind(user), "needle");
		await screen.findByText("1 / 1");
		const current = () =>
			[...(painted.get("find-current") ?? [])].map(
				(range) => range.startContainer.textContent,
			);
		const spoken = screen.getByText("1 of 1 match");
		expect(current()).toEqual(["out 5 needle"]);

		// The head drops and a match arrives: every row has moved up by one,
		// and the highlight stays on its line; the count grows unannounced.
		rerender(<View content={live(1, 201)} />);
		expect(screen.getByText("1 / 2")).toBeInTheDocument();
		expect(spoken).toHaveTextContent(/^1 of 1 match$/);
		await waitFor(() => expect(current()).toEqual(["out 5 needle"]));

		// The result, whole: the match is still the one being read.
		rerender(<View content={{ kind: "output", text: window(0, 201) }} />);
		expect(screen.getByText("1 / 2")).toBeInTheDocument();
		await waitFor(() => expect(current()).toEqual(["out 5 needle"]));
	});

	it("opens on Ctrl+F, and reopens with the query kept and selected", async () => {
		const user = userEvent.setup();
		layOut(1);
		render(<View content={{ kind: "output", text: "fail" }} />);
		await user.keyboard("{Control>}f{/Control}");
		const input = screen.getByRole("textbox", { name: "Find in output" });
		expect(input).toHaveFocus();
		await user.type(input, "fa");
		await user.click(screen.getByRole("button", { name: "Close find" }));

		await user.keyboard("{Control>}f{/Control}");
		const again = screen.getByRole<HTMLInputElement>("textbox", {
			name: "Find in output",
		});
		expect(again).toHaveValue("fa");
		expect(again).toHaveFocus();
		expect(again.selectionStart).toBe(0);
		expect(again.selectionEnd).toBe(2);
	});
});

describe("diffSegments", () => {
	it("is a diff's code cells alone, never its numbers or hunk headers", () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<table>
				<tr><td class="diff-line-hunk-content">@@ -1 +1 @@</td></tr>
				<tr>
					<td class="diff-line-old-num">1</td>
					<td><span class="diff-line-content-raw"><span>const</span> a</span></td>
				</tr>
			</table>`;
		expect(
			diffSegments(root).map((nodes) => nodes.map((n) => n.data).join("")),
		).toEqual(["const a"]);
	});
});
