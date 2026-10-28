import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findConflictRegions } from "../../lib/gitOperation";
import type { FileContent } from "../../types/contents";
import ConflictView, { type ConflictFile } from "./ConflictView";

// jsdom lays nothing out: each line is 20px tall, the view 200px of 2000.
const ROW = 20;
const VIEW = 200;
const HEIGHT = 2000;
const scrollTops = new WeakMap<Element, number>();
const stubs: [string, PropertyDescriptor][] = [
	[
		"offsetTop",
		{
			get(this: HTMLElement) {
				return Number(this.dataset.line ?? 0) * ROW;
			},
		},
	],
	["scrollHeight", { get: () => HEIGHT }],
	["clientHeight", { get: () => VIEW }],
	[
		"scrollTop",
		{
			get(this: Element) {
				return scrollTops.get(this) ?? 0;
			},
			set(this: Element, value: number) {
				// A browser clamps to what can be scrolled.
				scrollTops.set(this, Math.min(Math.max(value, 0), HEIGHT - VIEW));
			},
		},
	],
];
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	for (const [name, stub] of stubs) {
		saved.set(
			name,
			Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
		);
		Object.defineProperty(HTMLElement.prototype, name, {
			...stub,
			configurable: true,
		});
	}
});
afterEach(() => {
	for (const [name] of stubs) {
		const original = saved.get(name);
		if (original) Object.defineProperty(HTMLElement.prototype, name, original);
		else
			delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
				name
			];
	}
});

/** 100 lines with conflicts opening at lines 10, 40 and 95 (0-based). */
function markedText(): string {
	const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
	for (const start of [10, 40, 95]) {
		lines[start] = "<<<<<<< HEAD";
		lines[start + 2] = "=======";
		lines[start + 4] = ">>>>>>> theirs";
	}
	return lines.join("\n");
}

function conflictFile(content: string): ConflictFile {
	const data: FileContent = {
		name: "notes.unknownext",
		type: "file",
		path: "notes.unknownext",
		size: content.length,
		mime: "text/plain",
		content,
		encoding: "text",
	};
	return {
		contents: {
			data,
			isLoading: false,
			error: null,
		} as ConflictFile["contents"],
		text: { content, highlight: true },
		regions: findConflictRegions(content),
		resolvable: false,
		confirmResolvable: async () => false,
	};
}

describe("ConflictView", () => {
	it("jumps between conflicts and names the one at the top", async () => {
		const user = userEvent.setup();
		render(
			<ConflictView
				path="notes.unknownext"
				conflict="content"
				file={conflictFile(markedText())}
				wrap={false}
				onOpenFile={() => {}}
			/>,
		);
		const prev = screen.getByRole("button", { name: "Previous conflict" });
		const next = screen.getByRole("button", { name: "Next conflict" });

		// None above the top yet.
		expect(screen.getByText("3 conflicts")).toBeInTheDocument();
		expect(prev).toBeDisabled();

		await user.click(next);
		expect(screen.getByText("Conflict 1 of 3")).toBeInTheDocument();
		expect(prev).toBeDisabled();

		await user.click(next);
		expect(screen.getByText("Conflict 2 of 3")).toBeInTheDocument();
		expect(prev).toBeEnabled();

		// The last one cannot reach the top; at the bottom it is the one in view.
		await user.click(next);
		expect(screen.getByText("Conflict 3 of 3")).toBeInTheDocument();
		expect(next).toBeDisabled();

		await user.click(prev);
		expect(screen.getByText("Conflict 2 of 3")).toBeInTheDocument();
	});

	it("bands marker lines and rules every line of a region", () => {
		render(
			<ConflictView
				path="notes.unknownext"
				conflict="content"
				file={conflictFile(
					["a", "<<<<<<< HEAD", "b", "=======", "c", ">>>>>>> x", "d"].join(
						"\n",
					),
				)}
				wrap={false}
				onOpenFile={() => {}}
			/>,
		);
		const row = (text: string) => screen.getByText(text).parentElement;

		expect(row("<<<<<<< HEAD")).toHaveClass(
			"bg-th-warning/15",
			"border-th-warning",
		);
		expect(row("b")).toHaveClass("border-th-warning");
		expect(row("b")).not.toHaveClass("bg-th-warning/15");
		expect(row("a")).toHaveClass("border-transparent");
	});
});
