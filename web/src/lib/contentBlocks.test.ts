import { describe, expect, it } from "vitest";
import {
	contentBlockFiles,
	contentBlocksText,
	groupContentBlocks,
	parseContentBlocks,
	partitionFileBlocks,
} from "./contentBlocks";

describe("parseContentBlocks", () => {
	it("returns undefined for a result that carried no blocks", () => {
		expect(parseContentBlocks(undefined)).toBeUndefined();
		expect(parseContentBlocks("plain text")).toBeUndefined();
		expect(parseContentBlocks([])).toBeUndefined();
	});

	it("reads the three kinds the server sends", () => {
		expect(
			parseContentBlocks([
				{ type: "text", text: "PDF file read: /tmp/a.pdf" },
				{
					type: "file",
					file: {
						mime: "image/png",
						size: 7858,
						width: 64,
						height: 64,
						attachment_id: "abc",
					},
				},
				{ type: "tool_reference", tool_name: "Read" },
			]),
		).toEqual([
			{ type: "text", text: "PDF file read: /tmp/a.pdf" },
			{
				type: "file",
				file: {
					name: undefined,
					mime: "image/png",
					size: 7858,
					width: 64,
					height: 64,
					attachment_id: "abc",
					path: undefined,
					omitted: undefined,
					limit: undefined,
				},
			},
			{ type: "tool_reference", toolName: "Read" },
		]);
	});

	it("keeps a file block that carries only a reason", () => {
		const blocks = parseContentBlocks([
			{ type: "file", file: { mime: "application/pdf", omitted: "binary" } },
		]);
		expect(blocks?.[0]).toEqual({
			type: "file",
			file: expect.objectContaining({
				mime: "application/pdf",
				omitted: "binary",
			}),
		});
	});

	// Every reason in `OmitReason` has to survive the boundary. `not_fetched`
	// once did not, and the only producer of it is the background task log — so
	// the block reached the UI claiming no reason at all, and the one place that
	// tells a deliberately unread file from an unreadable one had nothing to
	// read.
	it("keeps every reason a block can carry", () => {
		const blocks = parseContentBlocks([
			{ type: "file", file: { mime: "text/plain", omitted: "not_fetched" } },
			{ type: "file", file: { mime: "text/plain", omitted: "invented" } },
		]);
		expect(
			blocks?.map((block) => block.type === "file" && block.file.omitted),
		).toEqual(["not_fetched", undefined]);
	});

	// The tool call offers a chevron exactly when there is a body, so a block
	// with nothing in it would make the chevron open onto nothing.
	it("drops a text block with nothing in it", () => {
		expect(parseContentBlocks([{ type: "text", text: "" }])).toBeUndefined();
		expect(
			parseContentBlocks([
				{ type: "text", text: "" },
				{ type: "file", file: { mime: "image/png", attachment_id: "a" } },
			]),
		).toHaveLength(1);
	});

	it("drops blocks it cannot read rather than rendering half of one", () => {
		expect(
			parseContentBlocks([
				{ type: "file" },
				{ type: "tool_reference" },
				{ type: "something_new", data: 1 },
				null,
			]),
		).toBeUndefined();
	});
});

describe("contentBlocksText", () => {
	it("joins the prose and leaves the rest out", () => {
		expect(
			contentBlocksText([
				{ type: "text", text: "line 1" },
				{ type: "file", file: { mime: "image/png", attachment_id: "a" } },
				{ type: "text", text: "line 2" },
			]),
		).toBe("line 1\nline 2");
	});
});

describe("contentBlockFiles", () => {
	it("returns the file blocks in the agent's order", () => {
		expect(
			contentBlockFiles([
				{ type: "text", text: "x" },
				{ type: "file", file: { mime: "image/png", attachment_id: "a" } },
				{ type: "file", file: { mime: "application/pdf", omitted: "binary" } },
			]).map((file) => file.mime),
		).toEqual(["image/png", "application/pdf"]);
	});

	// claude hands over the bytes and says nothing about where they came from,
	// so without this its Read of a workspace image loses both the file name and
	// the way over to the Files tab that codex's Read of the same file has.
	it("gives a lone block the file the call named", () => {
		expect(
			contentBlockFiles(
				[{ type: "file", file: { mime: "image/png", attachment_id: "a" } }],
				{ name: "Read", input: { file_path: "/work/shots/a.png" } },
			)[0].path,
		).toBe("/work/shots/a.png");
	});

	it("keeps the path the agent gave over the one the call named", () => {
		expect(
			contentBlockFiles(
				[
					{
						type: "file",
						file: { mime: "image/png", path: "/tmp/real.png" },
					},
				],
				{ name: "Read", input: { file_path: "/work/shots/a.png" } },
			)[0].path,
		).toBe("/tmp/real.png");
	});

	// One path cannot say which of several files it belongs to, and a guess puts
	// the wrong name under an image and offers to open something else.
	it("leaves several blocks alone", () => {
		expect(
			contentBlockFiles(
				[
					{ type: "file", file: { mime: "image/png", attachment_id: "a" } },
					{ type: "file", file: { mime: "image/png", attachment_id: "b" } },
				],
				{ name: "Read", input: { file_path: "/work/shots/a.png" } },
			).map((file) => file.path),
		).toEqual([undefined, undefined]);
	});

	it("is unchanged by a call that named no file", () => {
		expect(
			contentBlockFiles(
				[{ type: "file", file: { mime: "image/png", attachment_id: "a" } }],
				{ name: "Read", input: { pattern: "*.png" } },
			)[0].path,
		).toBeUndefined();
	});

	// A tool that takes a file_path need not answer with that file's content —
	// a chart drawn from a CSV is not the CSV — so only Read's contract is
	// strong enough to name a block after its input.
	it("does not name a block after another tool's file_path", () => {
		expect(
			contentBlockFiles(
				[{ type: "file", file: { mime: "image/png", attachment_id: "a" } }],
				{ name: "mcp__plot__chart", input: { file_path: "/work/data.csv" } },
			)[0].path,
		).toBeUndefined();
	});
});

describe("groupContentBlocks", () => {
	it("collapses consecutive runs and keeps their order", () => {
		expect(
			groupContentBlocks([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
				{ type: "tool_reference", toolName: "Read" },
				{ type: "tool_reference", toolName: "Edit" },
				{ type: "text", text: "c" },
			]),
		).toEqual([
			{ kind: "text", text: "a\nb" },
			{ kind: "tools", names: ["Read", "Edit"] },
			{ kind: "text", text: "c" },
		]);
	});

	it("leaves nothing to expand for a result that is only a file", () => {
		expect(
			groupContentBlocks([
				{ type: "file", file: { mime: "image/png", attachment_id: "a" } },
			]),
		).toEqual([]);
	});
});

describe("partitionFileBlocks", () => {
	// The one reason that says nobody tried to read the content: the block is a
	// pointer at a file, not the answer to the call, so it belongs beside the
	// outcome in the body rather than in the strip.
	it("treats a file nobody read as a reference", () => {
		expect(
			partitionFileBlocks([
				{ mime: "text/plain", path: "/tmp/build.log", omitted: "not_fetched" },
			]),
		).toEqual({
			attachments: [],
			references: [
				{ mime: "text/plain", path: "/tmp/build.log", omitted: "not_fetched" },
			],
		});
	});

	// Every other reason means the reader expected content and has to be told
	// why there is none, which is what the strip says.
	it("keeps the blocks that failed to deliver content in the strip", () => {
		const files = [
			{ mime: "image/png", omitted: "too_large" as const },
			{ mime: "application/octet-stream", omitted: "binary" as const },
			{ mime: "image/png", attachment_id: "a1" },
		];
		expect(partitionFileBlocks(files)).toEqual({
			attachments: files,
			references: [],
		});
	});

	it("drops a reference that points at nothing", () => {
		expect(
			partitionFileBlocks([{ mime: "text/plain", omitted: "not_fetched" }]),
		).toEqual({ attachments: [], references: [] });
	});
});
