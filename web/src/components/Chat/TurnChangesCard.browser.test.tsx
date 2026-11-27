import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ContentPart } from "../../types/message";
import { TurnChangesCard } from "./TurnChangesCard";

const edit = (id: string, path: string): ContentPart => ({
	type: "tool_call",
	id: `call-${id}`,
	tool: {
		id,
		name: "Edit",
		input: { file_path: path, old_string: "a\nb", new_string: "c\nd\ne" },
		status: "success",
	},
});
const work = { lastCallPartId: "call-3", calls: 7, durationMs: 64_000 };

/**
 * The line's visible words: the duration's own span is the first entry. Read
 * through `innerText`, which leaves out what the container query hides.
 */
const words = () =>
	screen.getByText(/^Worked \d/, { ignore: ".sr-only" })
		.parentElement as HTMLElement;

function inColumn(width: number, parts: ContentPart[]) {
	render(
		<div style={{ width }}>
			<TurnChangesCard parts={parts} work={work} />
		</div>,
	);
}

// The nouns shorten on the line's own width, which only real layout has
// (docs/tool-call-ui.md#the-work-line).
describe("the work line's width", () => {
	const files = [
		edit("1", "/repo/a.ts"),
		edit("2", "/repo/b.ts"),
		edit("3", "/repo/c.ts"),
	];

	it("shortens its nouns in a phone's column and keeps the totals in view", () => {
		inColumn(343, files);
		expect(words().innerText).toBe("Worked 1m 4s · 7 calls · 3 files");
		const header = words().closest(".\\@container");
		const totals = screen.getByText("+9");
		expect(header).not.toBeNull();
		expect(totals.getBoundingClientRect().right).toBeLessThanOrEqual(
			(header as HTMLElement).getBoundingClientRect().right,
		);
	});

	it("says it in full where there is room", () => {
		inColumn(720, files);
		expect(words().innerText).toBe(
			"Worked 1m 4s · 7 tool calls · 3 files changed",
		);
	});

	it("draws the bare line with a hairline through the rest of it", () => {
		inColumn(720, [
			{
				type: "tool_call",
				id: "call-3",
				tool: { id: "3", name: "Read", input: {}, status: "success" },
			},
		]);
		expect(words().innerText).toBe("Worked 1m 4s · 7 tool calls");
		const line = words().parentElement as HTMLElement;
		const rule = line.lastElementChild as HTMLElement;
		expect(rule.getBoundingClientRect().width).toBeGreaterThan(400);
		expect(line.getBoundingClientRect().height).toBeGreaterThanOrEqual(36);
	});
});
