import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ContentPart } from "../../types/message";
import MessageList from "./MessageList";
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

// Where the jump leaves the row is real layout: under the subagent's bar,
// which the jump itself pinned by opening its row
// (docs/tool-call-ui.md#from-a-file-to-the-calls-that-changed-it).
describe("going to a subagent's call", () => {
	const FILLER = Array.from(
		{ length: 12 },
		() => "The subagent reads the retry path before it touches anything.",
	).join(" ");
	const text = (id: string): ContentPart => ({
		type: "text",
		id: `text-${id}`,
		content: FILLER,
	});
	const read = (id: string): ContentPart => ({
		type: "tool_call",
		id: `call-${id}`,
		tool: {
			id,
			name: "Read",
			input: { file_path: "/repo/a.ts" },
			status: "success",
			result: "contents",
		},
	});

	it("lands the row just under the subagent's pinned bar", async () => {
		const user = userEvent.setup();
		const parts: ContentPart[] = [
			{
				type: "tool_call",
				id: "call-t1",
				tool: {
					id: "t1",
					name: "Agent",
					input: { description: "Fix the retry", prompt: "Fix it." },
					status: "success",
					result: "Fixed.",
					children: [
						...["1", "2", "3", "4", "5", "6"].map(text),
						read("c1"),
						edit("c2", "/repo/a.ts"),
						read("c3"),
						text("7"),
					],
				},
			},
			...["a", "b", "c", "d", "e", "f"].map(text),
		];
		render(
			<div className="flex flex-col" style={{ height: 600, width: 600 }}>
				<MessageList
					sessionId="s"
					messages={[
						{
							id: "m",
							role: "assistant",
							parts,
							status: "complete",
							createdAt: new Date(),
						},
					]}
				/>
			</div>,
		);

		await user.click(screen.getByRole("button", { name: /^a\.ts/ }));
		await user.click(
			screen.getByRole("button", {
				name: "Go to the call that made this change",
			}),
		);

		const scroller = document.querySelector(".overflow-y-auto") as HTMLElement;
		const row = document.querySelector('[data-tool-use-id="c2"]');
		const bar = document.querySelector('[data-tool-use-id="t1"] .row-bar');
		expect(row).not.toBeNull();
		expect(bar).not.toBeNull();
		const barRect = (bar as HTMLElement).getBoundingClientRect();
		const rowTop = (row as HTMLElement).getBoundingClientRect().top;
		// The bar is pinned at the view's top, and the row starts where it ends.
		expect(scroller.scrollTop).toBeGreaterThan(0);
		expect(barRect.top).toBeCloseTo(scroller.getBoundingClientRect().top, 0);
		expect(Math.abs(rowTop - barRect.bottom)).toBeLessThanOrEqual(1);
	});
});

// The header has room for it on a phone: the section's label gives way first,
// and the actions never move (docs/tool-call-ui.md#from-a-file-to-the-calls-that-changed-it).
describe("a change's header on a phone", () => {
	it("keeps Go to call and its neighbours inside the header", async () => {
		const user = userEvent.setup();
		const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
		const parts: ContentPart[] = [
			edit("1", "/repo/src/webhooks/sender/deliver.ts"),
			{
				type: "tool_call",
				id: "call-2",
				tool: {
					id: "2",
					name: "Edit",
					input: {
						file_path: "/repo/src/webhooks/sender/deliver.ts",
						old_string: "x",
						new_string: long,
					},
					status: "success",
				},
			},
		];
		render(
			<div className="flex flex-col" style={{ height: 700, width: 375 }}>
				<MessageList
					sessionId="s"
					messages={[
						{
							id: "m",
							role: "assistant",
							parts,
							status: "complete",
							createdAt: new Date(),
						},
					]}
				/>
			</div>,
		);
		await user.click(screen.getByRole("button", { name: /^deliver\.ts/ }));

		for (const name of ["Go to call 1 · Edit", "Go to call 2 · Edit"]) {
			const button = screen.getByRole("button", { name });
			const header = button.parentElement?.parentElement as HTMLElement;
			const box = header.getBoundingClientRect();
			for (const action of button.parentElement?.children ?? []) {
				const rect = action.getBoundingClientRect();
				expect(rect.right).toBeLessThanOrEqual(box.right + 0.5);
				expect(rect.left).toBeGreaterThanOrEqual(box.left);
			}
			// One line: the word does not wrap under its neighbours.
			expect(button.getBoundingClientRect().height).toBeLessThanOrEqual(24);
		}
	});
});
