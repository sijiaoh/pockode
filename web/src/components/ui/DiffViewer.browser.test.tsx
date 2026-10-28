import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffViewer } from "./DiffViewer";

function file(length: number, edits: Record<number, string> = {}): string {
	const lines = Array.from(
		{ length },
		(_, i) => edits[i + 1] ?? `line ${i + 1}`,
	);
	return `${lines.join("\n")}\n`;
}

function hunk(at: number, text: string): string {
	return [
		`@@ -${at - 3},7 +${at - 3},7 @@`,
		...[3, 2, 1].map((d) => ` line ${at - d}`),
		`-line ${at}`,
		`+${text}`,
		...[1, 2, 3].map((d) => ` line ${at + d}`),
	].join("\n");
}

// Unwrapped, the library draws a row of the caller's only once it has
// measured the table it sits in, which jsdom never lays out.
describe("hunk bars in a real browser", () => {
	it.each([
		["inline", false, false],
		["inline, wrapped", false, true],
		["side by side", true, false],
		["side by side, wrapped", true, true],
	])("are drawn, one per hunk, %s", async (_, split, wrap) => {
		const { container } = render(
			<div style={{ width: 900 }}>
				<DiffViewer
					fileName="a.txt"
					hunks={[
						`--- a/a.txt\n+++ b/a.txt\n${hunk(10, "ten")}\n${hunk(30, "thirty")}\n`,
					]}
					oldContent={file(40)}
					newContent={file(40, { 10: "ten", 30: "thirty" })}
					split={split}
					wrap={wrap}
					renderHunkBar={(_, index) => (
						<div data-bar={index} style={{ height: 44 }}>
							bar {index}
						</div>
					)}
				/>
			</div>,
		);

		await waitFor(
			() => {
				const bars = Array.from(
					container.querySelectorAll<HTMLElement>("[data-bar]"),
				);
				expect(bars.map((b) => b.dataset.bar)).toEqual(["0", "1"]);
				for (const bar of bars) {
					expect(bar.getBoundingClientRect().width).toBeGreaterThan(0);
				}
			},
			{ timeout: 20_000 },
		);
	});
});

// Where index.css puts the library's stylesheet in the cascade. Each side of
// it was lost once: the hunk bar's text and icons came out in CanvasText.
describe("the diff library's styles in the cascade", () => {
	it.each(["light", "dark"])("hold their place in %s", async (mode) => {
		const root = document.documentElement;
		root.classList.add("theme-abyss");
		root.classList.toggle("dark", mode === "dark");
		try {
			const { container } = render(
				<div style={{ width: 900 }}>
					<span data-reference className="text-th-text-primary" />
					<span data-reference-bg className="bg-th-bg-tertiary" />
					<DiffViewer
						fileName="a.txt"
						hunks={[`--- a/a.txt\n+++ b/a.txt\n${hunk(10, "ten")}\n`]}
						oldContent={file(20)}
						newContent={file(20, { 10: "ten" })}
						renderHunkBar={() => (
							<span data-bar className="text-th-text-primary">
								bar <svg data-icon aria-hidden="true" />
							</span>
						)}
					/>
				</div>,
			);
			const bar = await waitFor(
				() => {
					const found = container.querySelector("[data-bar]");
					expect(found).not.toBeNull();
					return found as Element;
				},
				{ timeout: 20_000 },
			);
			const style = (selector: string) => {
				const el = container.querySelector(selector);
				expect(el, selector).not.toBeNull();
				return getComputedStyle(el as Element);
			};

			// A utility on a row of ours beats the library's reset, and what
			// names no colour of its own — an icon — inherits it.
			const themed = style("[data-reference]").color;
			expect(getComputedStyle(bar).color).toBe(themed);
			expect(style("[data-bar] [data-icon]").color).toBe(themed);
			// Our theme's `--diff-*` values beat the library's own.
			expect(style(".diff-line-hunk-content").backgroundColor).toBe(
				style("[data-reference-bg]").backgroundColor,
			);
			// And the library still beats preflight's `padding: 0`.
			expect(style(".diff-widget-tooltip").paddingTop).toBe("6px");
		} finally {
			root.classList.remove("theme-abyss", "dark");
		}
	});
});
