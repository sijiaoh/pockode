import { describe, expect, it } from "vitest";
import type { FullScreenContent } from "./fullScreen";
import { hugeOpenLabel, isHuge, sliceContent } from "./hugeContent";
import { proposedChange } from "./proposedChange";

const lines = (n: number, prefix = "line") =>
	Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

// A phone's transcript: 562px is 35 rows, so huge is past 105.
const phone = { transcriptRows: 35, charsPerRow: 50 };

describe("isHuge", () => {
	it("holds output past three transcripts of rows, and not below", () => {
		expect(isHuge({ kind: "output", text: lines(106) }, phone)).toBe(true);
		expect(isHuge({ kind: "output", text: lines(105) }, phone)).toBe(false);
	});

	it("counts output's long lines as the rows they wrap to", () => {
		// 30 lines of 200 characters wrap to 4 rows each on a 50-character row.
		const text = Array.from({ length: 30 }, () => "x".repeat(200)).join("\n");
		expect(isHuge({ kind: "output", text }, phone)).toBe(true);
		// Code keeps its lines whole: 30 lines are 30 rows however long.
		expect(isHuge({ kind: "code", text }, phone)).toBe(false);
	});

	it("never holds a file list or live output, which are bounded already", () => {
		const paths = Array.from({ length: 3000 }, (_, i) => `/src/f${i}.ts`);
		expect(isHuge({ kind: "files", paths }, phone)).toBe(false);
		expect(
			isHuge(
				{ kind: "output", text: lines(200), live: { droppedLines: 50 } },
				phone,
			),
		).toBe(false);
	});

	it("counts a diff by its rows", () => {
		const change = proposedChange("Edit", {
			file_path: "/a.ts",
			old_string: lines(80, "old"),
			new_string: lines(80, "new"),
		});
		if (!change) throw new Error("no change");
		expect(isHuge({ kind: "change", change }, phone)).toBe(true);
	});
});

describe("sliceContent", () => {
	it("keeps the end of content read from its end, and its failure", () => {
		const slice = sliceContent(
			{ kind: "output", text: `${lines(10_000)}\n`, failedTail: true },
			"end",
		);
		if (slice.kind !== "output") throw new Error("kind");
		const kept = slice.text.split("\n");
		expect(kept.at(-1)).toBe("line 10000");
		expect(kept.length).toBeLessThan(100);
		expect(slice.failedTail).toBe(true);
	});

	it("keeps the head of content read from its start, without its failure", () => {
		const slice = sliceContent(
			{ kind: "output", text: lines(10_000), failedTail: true },
			"start",
		);
		if (slice.kind !== "output") throw new Error("kind");
		expect(slice.text.split("\n")[0]).toBe("line 1");
		expect(slice.failedTail).toBe(false);
	});

	it("cuts a megabyte on one line down to a slice", () => {
		const slice = sliceContent(
			{ kind: "output", text: "x".repeat(1_000_000) },
			"end",
		);
		if (slice.kind !== "output") throw new Error("kind");
		expect(slice.text.length).toBeLessThan(20_000);
	});

	it("cuts Markdown between blocks, and closes a fence it cuts inside", () => {
		const paragraph = `${lines(45, "para")}\n\nafter`;
		const cut = sliceContent(
			{ kind: "markdown", markdown: paragraph },
			"start",
		);
		if (cut.kind !== "markdown") throw new Error("kind");
		expect(cut.markdown).toContain("para 45");
		expect(cut.markdown).not.toContain("after");

		const fence = `\`\`\`ts\n${lines(500, "code")}\n\`\`\`\n\ntail`;
		const fenced = sliceContent({ kind: "markdown", markdown: fence }, "start");
		if (fenced.kind !== "markdown") throw new Error("kind");
		expect(fenced.markdown.endsWith("\n```")).toBe(true);
		expect(fenced.markdown).not.toContain("tail");
	});

	it("keeps a diff's first hunks whole", () => {
		// Changes far apart, so each is a hunk of its own.
		const before = lines(1000);
		const after = before
			.split("\n")
			.map((line, i) => (i % 50 === 0 ? `${line} changed` : line))
			.join("\n");
		const change = proposedChange("Edit", {
			file_path: "/a.ts",
			old_string: before,
			new_string: after,
		});
		if (change?.kind !== "edit") throw new Error("kind");
		const content: FullScreenContent = { kind: "change", change };
		const slice = sliceContent(content, "start");
		if (slice.kind !== "change" || slice.change.kind !== "edit")
			throw new Error("kind");
		const hunks = (patch: string) => patch.match(/^@@/gm)?.length ?? 0;
		const kept = hunks(slice.change.patches[0]);
		expect(kept).toBeGreaterThan(0);
		expect(kept).toBeLessThan(hunks(change.patches[0]));
		// Each hunk kept is whole: the slice is a prefix of the patch that ends
		// where the next hunk starts.
		const full = change.patches[0];
		expect(full.startsWith(slice.change.patches[0])).toBe(true);
		expect(full.slice(slice.change.patches[0].length)).toMatch(/^\n@@/);
	});
});

describe("huge content's edges", () => {
	it("cuts a new file's single hunk instead of drawing it whole", () => {
		const change = proposedChange("Edit", {
			file_path: "/a.ts",
			old_string: "x",
			new_string: lines(10_000),
		});
		if (change?.kind !== "edit") throw new Error("kind");
		const slice = sliceContent({ kind: "change", change }, "start");
		if (slice.kind !== "change" || slice.change.kind !== "edit")
			throw new Error("kind");
		const [patch] = slice.change.patches;
		const body = patch.split("\n").filter((line) => /^[ +-]/.test(line));
		expect(body.length).toBeLessThan(60);
		// The header's counts say what is kept, so the library draws it true.
		const header = /^@@ -1,(\d+) \+1,(\d+) @@/m.exec(patch);
		const removed = body.filter((l) => /^[-]/.test(l) && !l.startsWith("---"));
		const added = body.filter((l) => /^[+]/.test(l) && !l.startsWith("+++"));
		expect(Number(header?.[1])).toBe(removed.length);
		expect(Number(header?.[2])).toBe(added.length);
	});

	it("keeps a later patch's hunk whole rather than leave a stub of it", () => {
		const change = proposedChange("MultiEdit", {
			file_path: "/a.ts",
			edits: [
				{ old_string: "x", new_string: lines(37, "x") },
				{ old_string: "y", new_string: lines(10, "y") },
			],
		});
		if (change?.kind !== "multiEdit") throw new Error("kind");
		const slice = sliceContent({ kind: "change", change }, "start");
		if (slice.kind !== "change" || slice.change.kind !== "multiEdit")
			throw new Error("kind");
		expect(slice.change.patches).toEqual(change.patches);
	});

	it("keeps an escape sequence whole where a long line's tail is cut", () => {
		// 16,000 characters are kept: these cut 1–4 characters into `ESC[31m`.
		for (let x = 15_996; x < 16_000; x++) {
			const slice = sliceContent(
				{ kind: "output", text: `\x1b[31m${"x".repeat(x)}` },
				"end",
			);
			if (slice.kind !== "output") throw new Error("kind");
			expect(slice.text.startsWith("\x1b[31m")).toBe(true);
		}
	});

	it("does not count the newline output ends with as a row", () => {
		expect(isHuge({ kind: "output", text: `${lines(105)}\n` }, phone)).toBe(
			false,
		);
	});

	it("counts Markdown's long paragraphs as the rows they wrap to", () => {
		const page = Array.from({ length: 30 }, () => "word ".repeat(200)).join(
			"\n\n",
		);
		expect(isHuge({ kind: "markdown", markdown: page }, phone)).toBe(true);
	});

	it("never holds text whose attachments a slice would drop", () => {
		expect(
			isHuge(
				{ kind: "output", text: lines(10_000), withAttachments: true },
				phone,
			),
		).toBe(false);
	});

	it("does not take a fence line with an info string for a closing one", () => {
		const fence = `\`\`\`md\n${lines(10, "a")}\n\`\`\`ts\n${lines(500, "b")}\n\`\`\`\n\ntail`;
		const cut = sliceContent({ kind: "markdown", markdown: fence }, "start");
		if (cut.kind !== "markdown") throw new Error("kind");
		expect(cut.markdown.endsWith("\n```")).toBe(true);
	});
});

describe("hugeOpenLabel", () => {
	it("counts what it opens, with separators", () => {
		expect(
			hugeOpenLabel("output", { kind: "output", text: lines(12_408) }),
		).toEqual({
			label: "Open full output · 12,408 lines",
			name: "Open full output, 12,408 lines",
		});
	});

	it("opens all of a plural, and counts nothing it has no unit for", () => {
		expect(
			hugeOpenLabel("results", { kind: "output", text: "one" }).label,
		).toBe("Open all results · 1 line");
		expect(
			hugeOpenLabel("page", { kind: "markdown", markdown: "# Hi" }),
		).toEqual({ label: "Open full page", name: "Open full page" });
	});
});
