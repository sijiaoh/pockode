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
