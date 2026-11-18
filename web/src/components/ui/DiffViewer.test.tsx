import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import { getDiffHighlighterFor } from "../../lib/shikiUtils";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { DiffViewer } from "./DiffViewer";

// The library measures its line-number column on a canvas, which jsdom lacks.
beforeAll(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		() =>
			({
				font: "",
				measureText: () => ({ width: 8 }),
			}) as unknown as CanvasRenderingContext2D,
	);
});

afterAll(() => {
	vi.restoreAllMocks();
});

function file(length: number, edits: Record<number, string> = {}): string {
	const lines = Array.from(
		{ length },
		(_, i) => edits[i + 1] ?? `line ${i + 1}`,
	);
	return `${lines.join("\n")}\n`;
}

/** A one-line change at `at`, with git's three lines of context. */
function hunk(at: number, oldText: string, newText: string): string {
	const context = (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, i) => ` line ${from + i}`);
	return [
		`@@ -${at - 3},7 +${at - 3},7 @@`,
		...context(at - 3, at - 1),
		`-${oldText}`,
		`+${newText}`,
		...context(at + 1, at + 3),
	].join("\n");
}

function patch(...hunks: string[]): string {
	return `--- a/a.txt\n+++ b/a.txt\n${hunks.join("\n")}\n`;
}

function gapLabels(container: HTMLElement): (string | null)[] {
	return Array.from(
		container.querySelectorAll(".diff-line-hunk-content"),
		(cell) => cell.getAttribute("data-unchanged"),
	);
}

function gapCell(container: HTMLElement, label: string): HTMLElement {
	const cell = container.querySelector<HTMLElement>(
		`[data-unchanged="${label}"]`,
	);
	if (!cell) throw new Error(`no gap labelled ${label}`);
	return cell;
}

describe("DiffViewer", () => {
	const oldContent = file(60);
	const newContent = file(60, { 30: "line thirty" });
	const hunks = [patch(hunk(30, "line 30", "line thirty"))];

	it("says how many unchanged lines each collapsed gap hides", async () => {
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
			/>,
		);

		await waitFor(() =>
			expect(gapLabels(container)).toEqual([
				"26 unchanged lines",
				"27 unchanged lines",
			]),
		);
		expect(screen.queryByText("line 1")).toBeNull();
	});

	it("expands a gap from a press anywhere on its row", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
			/>,
		);

		await user.click(
			await waitFor(() => gapCell(container, "26 unchanged lines")),
		);

		expect(await screen.findByText("line 1")).toBeTruthy();
		expect(gapLabels(container)).toEqual(["27 unchanged lines"]);
	});

	it("counts down a long gap between hunks as it is revealed", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={[
					patch(hunk(10, "line 10", "ten"), hunk(100, "line 100", "hundred")),
				]}
				oldContent={file(110)}
				newContent={file(110, { 10: "ten", 100: "hundred" })}
			/>,
		);

		// Lines 14 to 96 lie between the two hunks; a press reveals the
		// library's step of 40 from the hunk above.
		await user.click(
			await waitFor(() => gapCell(container, "83 unchanged lines")),
		);

		expect(await screen.findByText("line 14")).toBeTruthy();
		await waitFor(() =>
			expect(gapLabels(container)).toContain("43 unchanged lines"),
		);
	});

	it("keeps what was expanded when only the wrap changes", async () => {
		const user = userEvent.setup();
		const { container, rerender } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
			/>,
		);
		await user.click(
			await waitFor(() => gapCell(container, "26 unchanged lines")),
		);
		await screen.findByText("line 1");

		// A fresh array of the same hunks, as a caller building it in render
		// passes: still the same diff.
		rerender(
			<DiffViewer
				fileName="a.txt"
				hunks={[...hunks]}
				oldContent={oldContent}
				newContent={newContent}
				wrap
			/>,
		);

		expect(screen.getByText("line 1")).toBeTruthy();
	});

	it("marks the changed words within a modified line", async () => {
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
			/>,
		);

		await waitFor(() =>
			expect(container.querySelectorAll("[data-range-start]")).toHaveLength(2),
		);
	});

	it("offers no expansion without both files", async () => {
		const { container } = render(<DiffViewer fileName="a.txt" hunks={hunks} />);

		await screen.findByText("line 31");
		expect(container.querySelector(".diff-line-hunk-action button")).toBeNull();
		expect(gapLabels(container).every((label) => label === null)).toBe(true);
	});

	describe.each([
		["", false],
		[" and wrapped", true],
	])("side by side%s", (_, wrap) => {
		const renderSplit = () =>
			render(
				<DiffViewer
					fileName="a.txt"
					hunks={hunks}
					oldContent={oldContent}
					newContent={newContent}
					wrap={wrap}
					split
				/>,
			);

		it("says how many unchanged lines each gap hides, and expands it", async () => {
			const user = userEvent.setup();
			const { container } = renderSplit();

			await user.click(
				await waitFor(() => gapCell(container, "26 unchanged lines")),
			);

			// Once per side.
			expect(await screen.findAllByText("line 1")).toHaveLength(2);
			expect(gapLabels(container)).toEqual(["27 unchanged lines"]);
		});

		it("keeps the word highlight", async () => {
			const { container } = renderSplit();

			await waitFor(() =>
				expect(container.querySelectorAll("[data-range-start]")).toHaveLength(
					2,
				),
			);
		});
	});

	// The toggle switches a viewer already on screen: the labels must follow
	// the rows the new mode draws, read from that mode's own bookkeeping.
	it("labels the gaps again when switched to side by side", async () => {
		const user = userEvent.setup();
		const props = { fileName: "a.txt", hunks, oldContent, newContent };
		const { container, rerender } = render(<DiffViewer {...props} />);
		await user.click(
			await waitFor(() => gapCell(container, "26 unchanged lines")),
		);
		await screen.findByText("line 1");

		rerender(<DiffViewer {...props} split />);

		await waitFor(() =>
			expect(container.querySelector(".split-diff-view")).not.toBeNull(),
		);
		// Split view keeps its own record of what is expanded.
		await waitFor(() =>
			expect(gapLabels(container)).toEqual([
				"26 unchanged lines",
				"27 unchanged lines",
			]),
		);
		await user.click(gapCell(container, "27 unchanged lines"));
		await waitFor(() =>
			expect(gapLabels(container)).toEqual(["26 unchanged lines"]),
		);
	});

	// Unwrapped, each side is a table of its own: the new side's half of a gap
	// row has no button, and is still the row.
	it("expands a gap from the new side's half of its row", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={hunks}
				oldContent={oldContent}
				newContent={newContent}
				split
			/>,
		);
		await waitFor(() => gapCell(container, "26 unchanged lines"));
		const placeholder = container.querySelector<HTMLElement>(
			".new-diff-table .diff-line-hunk-placeholder",
		);
		if (!placeholder) throw new Error("no placeholder for the first gap");

		await user.click(placeholder);

		expect(await screen.findAllByText("line 1")).toHaveLength(2);
	});
});

describe("DiffViewer hunk bars", () => {
	// Wrapped: unwrapped, the library draws a row of the caller's only once it
	// has measured the table, which jsdom never lays out.
	const bars = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("[data-bar]"), (bar) => {
			const row = bar.closest("tr");
			return {
				bar: bar.getAttribute("data-bar"),
				// The line drawn just above the bar's row.
				after: row?.previousElementSibling?.textContent?.trim(),
			};
		});

	it.each([
		["inline", false],
		["side by side", true],
	])("draws one under each hunk's last line, %s", async (_, split) => {
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={[
					patch(hunk(10, "line 10", "ten"), hunk(30, "line 30", "thirty")),
				]}
				oldContent={file(40)}
				newContent={file(40, { 10: "ten", 30: "thirty" })}
				wrap
				split={split}
				renderHunkBar={(h, index) => (
					<div data-bar={`${index}:${h.newStart}`} />
				)}
			/>,
		);

		await waitFor(() => expect(bars(container)).toHaveLength(2));
		expect(bars(container)).toEqual([
			{ bar: "0:7", after: expect.stringContaining("line 13") },
			{ bar: "1:27", after: expect.stringContaining("line 33") },
		]);
	});

	it("keeps them once the gap between two hunks is expanded", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={[
					patch(hunk(10, "line 10", "ten"), hunk(20, "line 20", "twenty")),
				]}
				oldContent={file(30)}
				newContent={file(30, { 10: "ten", 20: "twenty" })}
				wrap
				renderHunkBar={(_, index) => <div data-bar={index} />}
			/>,
		);

		await user.click(
			await waitFor(() => gapCell(container, "3 unchanged lines")),
		);
		await screen.findByText("line 15");

		expect(bars(container).map((b) => b.bar)).toEqual(["0", "1"]);
	});

	// At the end of a file the hunk can end on a change rather than on context,
	// and then the layouts disagree on which row is last: unified draws the
	// addition after the removals, split pairs it with the first removal.
	it.each([
		["inline", false, "thirty-nine"],
		["side by side", true, "line 40"],
	])("hangs it under the last row of a hunk ending in a change, %s", async (_, split, last) => {
		const { container } = render(
			<DiffViewer
				fileName="a.txt"
				hunks={[
					patch(
						[
							"@@ -37,4 +37,3 @@",
							" line 37",
							" line 38",
							"-line 39",
							"-line 40",
							"+thirty-nine",
						].join("\n"),
					),
				]}
				oldContent={file(40)}
				newContent={`${file(38)}thirty-nine\n`}
				wrap
				split={split}
				renderHunkBar={(_, index) => <div data-bar={index} />}
			/>,
		);

		await waitFor(() => expect(bars(container)).toHaveLength(1));
		expect(bars(container)[0].after).toContain(last);
	});
});

describe("DiffViewer syntax colours", () => {
	/** A one-line change in a file only the hunk is known of. */
	function change(fileName: string, oldLine: string, newLine: string) {
		return render(
			<DiffViewer
				fileName={fileName}
				hunks={[
					`--- a/${fileName}\n+++ b/${fileName}\n@@ -1,1 +1,1 @@\n-${oldLine}\n+${newLine}\n`,
				]}
			/>,
		);
	}

	/** The colours the line's tokens are drawn in, as shiki writes them. */
	function colours(container: HTMLElement, text: string): Set<string> {
		const line = Array.from(
			container.querySelectorAll<HTMLElement>(".diff-line-syntax-raw"),
		).find((cell) => cell.textContent?.includes(text));
		if (!line) throw new Error(`no line holding ${text}`);
		return new Set(
			Array.from(line.querySelectorAll<HTMLElement>("[data-start]"), (token) =>
				token.style.getPropertyValue("--diff-view-light"),
			).filter(Boolean),
		);
	}

	// highlight.js marks its tokens with classes, shiki with colours: a diff
	// coloured by classes went to the fallback, not to shiki. Plain text looks
	// the same from either; which one draws it is held in shikiUtils.test.ts.
	function highlightJsTokens(container: HTMLElement) {
		return container.querySelectorAll("[class*='hljs']");
	}

	// Languages the adapter does not preload, which used to reach highlight.js,
	// and a file named with no extension at all.
	it.each([
		["src/main.rs", "fn main() {}", "fn main() { let x = 1; }", "let x"],
		["config.yaml", "name: a", "name: b # set", "# set"],
		["Dockerfile", "FROM node:20", 'RUN echo "hi"', "RUN"],
		["include/util.hpp", "int a;", "class A {};", "class"],
	])("colours %s with shiki", async (fileName, oldLine, newLine, newText) => {
		const { container } = change(fileName, oldLine, newLine);

		await screen.findByText((_, el) =>
			Boolean(
				el?.matches(".diff-line-syntax-raw") &&
					el.textContent?.includes(newText),
			),
		);
		expect(colours(container, newText).size).toBeGreaterThan(1);
		expect(highlightJsTokens(container)).toHaveLength(0);
	});

	// Languages shiki has no grammar for, which highlight.js still colours.
	it.each([
		["api/service.thrift", "struct A {}", "service S { void ping() }", "ping"],
		["hotkeys.ahk", "a::b", '^j::Send, "hi" ; greet', "greet"],
	])("colours %s with highlight.js", async (fileName, oldLine, newLine, newText) => {
		const { container } = change(fileName, oldLine, newLine);

		await screen.findByText((_, el) =>
			Boolean(
				el?.matches(".diff-line-syntax-raw") &&
					el.textContent?.includes(newText),
			),
		);
		const classes = new Set(
			Array.from(highlightJsTokens(container), (token) => token.className),
		);
		expect(classes.size).toBeGreaterThan(1);
	});

	it("draws a diff in a language already loaded without waiting", async () => {
		const first = change("src/a.rs", "fn a() {}", "fn b() {}");
		await screen.findByText((_, el) =>
			Boolean(
				el?.matches(".diff-line-syntax-raw") &&
					el.textContent?.includes("fn b"),
			),
		);
		first.unmount();

		const { container } = change("src/c.rs", "fn c() {}", "fn d() {}");

		expect(screen.queryByText("Loading...")).toBeNull();
		expect(colours(container, "fn d").size).toBeGreaterThan(1);
	});

	describe("past HIGHLIGHT_LIMIT", () => {
		// Half the limit in characters but over it in UTF-8 bytes, as one long
		// line: the shape of a minified bundle, few lines and a lot of text.
		const long = `// ${"中".repeat(HIGHLIGHT_LIMIT / 2)}`;
		const short = "// x";
		const fileName = "src/main.zig";
		const change = "@@ -1,1 +1,1 @@\n-fn a() {}\n+fn b() {}";

		it.each([
			["the old side", `fn a() {}\n${long}\n`, `fn b() {}\n${short}\n`, change],
			["the new side", `fn a() {}\n${short}\n`, `fn b() {}\n${long}\n`, change],
			[
				"the hunks",
				undefined,
				undefined,
				`${change.replace("1,1", "1,2").replace("+1,1", "+1,2")}\n ${long}`,
			],
		])("draws plain text when %s is over, loading no grammar", async (_, oldContent, newContent, hunk) => {
			const { highlighter } = await getDiffHighlighterFor(undefined);
			const engine = highlighter.getHighlighterEngine();
			if (!engine || !("loadLanguage" in engine)) {
				throw new Error("the adapter has no shiki engine");
			}
			const load = vi.spyOn(engine, "loadLanguage");
			onTestFinished(() => load.mockRestore());

			const { container } = render(
				<DiffViewer
					fileName={fileName}
					hunks={[`--- a/${fileName}\n+++ b/${fileName}\n${hunk}\n`]}
					oldContent={oldContent}
					newContent={newContent}
				/>,
			);

			expect(screen.queryByText("Loading...")).toBeNull();
			// Highlighting off, the library draws the raw text, not syntax lines.
			await screen.findByText((_, el) =>
				Boolean(
					el?.matches(".diff-line-content-raw") &&
						el.textContent?.includes("fn b"),
				),
			);
			expect(container.querySelector(".diff-line-syntax-raw")).toBeNull();
			expect(highlightJsTokens(container)).toHaveLength(0);
			expect(load).not.toHaveBeenCalled();
		});

		it("still colours the same diff once it is back under", async () => {
			const { container } = render(
				<DiffViewer
					fileName={fileName}
					hunks={[`--- a/${fileName}\n+++ b/${fileName}\n${change}\n`]}
					oldContent={`fn a() {}\n${short}\n`}
					newContent={`fn b() {}\n${short}\n`}
				/>,
			);

			await screen.findByText((_, el) =>
				Boolean(
					el?.matches(".diff-line-syntax-raw") &&
						el.textContent?.includes("fn b"),
				),
			);
			expect(colours(container, "fn b").size).toBeGreaterThan(1);
		});

		// A patch holds both sides at once: one rewriting a file each of whose
		// sides is under the limit is over it as a whole, and still coloured.
		it("measures a patch's sides apart", async () => {
			const half = `// ${"x".repeat(HIGHLIGHT_LIMIT * 0.6)}`;
			const { container } = render(
				<DiffViewer
					fileName={fileName}
					hunks={[
						`--- a/${fileName}\n+++ b/${fileName}\n@@ -1,2 +1,2 @@\n-fn a() {}\n-${half}\n+fn b() {}\n+${half}y\n`,
					]}
				/>,
			);

			await screen.findByText((_, el) =>
				Boolean(
					el?.matches(".diff-line-syntax-raw") &&
						el.textContent?.includes("fn b"),
				),
			);
			expect(colours(container, "fn b").size).toBeGreaterThan(1);
		});
	});

	it("shows a language shiki has no grammar for as plain text", async () => {
		const { container } = change("notes.qqq", "if (a) {", "while (b) {");

		await screen.findByText((_, el) =>
			Boolean(
				el?.matches(".diff-line-syntax-raw") &&
					el.textContent?.includes("while"),
			),
		);
		expect(colours(container, "while").size).toBe(0);
		expect(highlightJsTokens(container)).toHaveLength(0);
	});

	it("shows plain text when the grammar fails to load", async () => {
		const { highlighter } = await getDiffHighlighterFor(undefined);
		const engine = highlighter.getHighlighterEngine();
		if (!engine || !("loadLanguage" in engine)) {
			throw new Error("the adapter has no shiki engine");
		}
		const load = vi
			.spyOn(engine, "loadLanguage")
			.mockRejectedValueOnce(new Error("chunk failed"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => {
			load.mockRestore();
			error.mockRestore();
		});

		const { container } = change("init.lua", "local a = 1", "local b = 2");

		await screen.findByText((_, el) =>
			Boolean(
				el?.matches(".diff-line-syntax-raw") &&
					el.textContent?.includes("local b"),
			),
		);
		expect(colours(container, "local b").size).toBe(0);
		expect(highlightJsTokens(container)).toHaveLength(0);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("lua"),
			expect.any(Error),
		);
	});
});
