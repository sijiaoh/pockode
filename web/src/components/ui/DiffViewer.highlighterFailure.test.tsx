import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { getDiffHighlighterFor } from "../../lib/shikiUtils";
import { DiffViewer } from "./DiffViewer";

// Its own file: the highlighter is made once per module instance, and every
// other test needs it made.
const { failNext } = vi.hoisted(() => ({ failNext: { count: 0 } }));
vi.mock("@git-diff-view/shiki", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@git-diff-view/shiki")>();
	return {
		...actual,
		getDiffViewHighlighter: (
			...args: Parameters<typeof actual.getDiffViewHighlighter>
		) => {
			if (failNext.count > 0) {
				failNext.count--;
				return Promise.reject(new Error("shiki failed to start"));
			}
			return actual.getDiffViewHighlighter(...args);
		},
	};
});

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

it("shows plain text when the highlighter itself cannot be had, and retries", async () => {
	failNext.count = 1;
	const error = vi.spyOn(console, "error").mockImplementation(() => {});

	const { container } = render(
		<DiffViewer
			fileName="src/main.ts"
			hunks={[
				"--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const b = 2;\n",
			]}
		/>,
	);

	await screen.findByText((_, el) =>
		Boolean(
			el?.matches(".diff-line-syntax-raw") &&
				el.textContent?.includes("const b"),
		),
	);
	expect(screen.queryByText("Loading...")).toBeNull();
	expect(
		container.querySelectorAll("[data-start][style*='--diff-view-light']"),
	).toHaveLength(0);
	expect(error).toHaveBeenCalledWith(
		expect.stringContaining("highlighter"),
		expect.any(Error),
	);
	error.mockRestore();

	// Not remembered: the next diff gets shiki.
	const { language } = await getDiffHighlighterFor("typescript");
	expect(language).toBe("typescript");
});
