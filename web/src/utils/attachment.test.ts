import { describe, expect, it } from "vitest";
import type { FileBlock } from "../types/content";
import {
	attachmentDetail,
	attachmentFileName,
	attachmentName,
	attachmentSource,
	omittedLabel,
	workspacePath,
} from "./attachment";

const WORK_DIR = "/Users/me/project";

function block(overrides: Partial<FileBlock> = {}): FileBlock {
	return { mime: "image/png", ...overrides };
}

describe("attachmentSource", () => {
	it("reads stored content by id", () => {
		expect(
			attachmentSource(block({ attachment_id: "abc" }), "s1", WORK_DIR),
		).toEqual({ kind: "attachment", sessionId: "s1", id: "abc" });
	});

	// Codex stores the bytes and names the file; the bytes are the cheaper read
	// and the one that works whatever the path turns out to be.
	it("prefers stored content over the path beside it", () => {
		expect(
			attachmentSource(
				block({ attachment_id: "abc", path: `${WORK_DIR}/a.png` }),
				"s1",
				WORK_DIR,
			),
		).toEqual({ kind: "attachment", sessionId: "s1", id: "abc" });
	});

	it("reads a named file through the work directory", () => {
		expect(
			attachmentSource(
				block({ path: `${WORK_DIR}/shots/a.png` }),
				"s1",
				WORK_DIR,
			),
		).toEqual({ kind: "file", path: "shots/a.png" });
	});

	// Every route into a file takes a work-directory-relative path, so there is
	// nothing to ask with — the block is still shown, it just has no content.
	it("has nothing to read for a path outside the work directory", () => {
		expect(
			attachmentSource(block({ path: "/tmp/a.png" }), "s1", WORK_DIR),
		).toBeNull();
	});

	it("has nothing to read for content the server left out", () => {
		expect(
			attachmentSource(
				block({ attachment_id: "abc", omitted: "too_large" }),
				"s1",
				WORK_DIR,
			),
		).toBeNull();
	});

	// `unavailable` says the server could not keep the content, not that
	// anything is wrong with it — so a file still in the work directory is
	// worth reading, and the image appears after all.
	it("still reads the file when the content could not be kept", () => {
		expect(
			attachmentSource(
				block({ path: `${WORK_DIR}/a.png`, omitted: "unavailable" }),
				"s1",
				WORK_DIR,
			),
		).toEqual({ kind: "file", path: "a.png" });
	});

	// The other two reasons are statements about the content: the same ceiling
	// and the same refusal would come back from the file, after a round trip.
	it("does not re-ask the file for content it was already refused", () => {
		for (const omitted of ["too_large", "binary"] as const) {
			expect(
				attachmentSource(
					block({ path: `${WORK_DIR}/a.png`, omitted }),
					"s1",
					WORK_DIR,
				),
			).toBeNull();
		}
	});
});

describe("workspacePath", () => {
	// Kept apart from attachmentSource: an agent can both hand over the content
	// and say where it came from, and the way over is still the path.
	it("names the file even when the bytes come from the store", () => {
		expect(
			workspacePath(
				block({ attachment_id: "abc", path: `${WORK_DIR}/shots/a.png` }),
				WORK_DIR,
			),
		).toBe("shots/a.png");
	});

	it("is null outside the work directory, and with no path at all", () => {
		expect(workspacePath(block({ path: "/tmp/a.png" }), WORK_DIR)).toBeNull();
		expect(workspacePath(block(), WORK_DIR)).toBeNull();
	});
});

describe("attachmentName", () => {
	it("uses the name the agent gave, then the file it named", () => {
		expect(attachmentName(block({ name: "shot.png" }))).toBe("shot.png");
		expect(attachmentName(block({ path: "/tmp/a/b.png" }))).toBe("b.png");
	});

	// Content handed over inline was never a file, so it is described rather
	// than given a file name it does not have.
	it("describes content that names no file", () => {
		expect(attachmentName(block({ attachment_id: "abc" }))).toBe("PNG image");
		expect(attachmentName(block({ mime: "application/pdf" }))).toBe("PDF file");
		expect(attachmentName(block({ mime: "" }))).toBe("File");
	});
});

describe("attachmentFileName", () => {
	// A download named after the label reaches the disk with no extension,
	// where neither the OS nor the user can open it.
	it("gives content that names no file an extension to be saved under", () => {
		expect(attachmentFileName(block({ attachment_id: "abc" }))).toBe(
			"image.png",
		);
		expect(attachmentFileName(block({ mime: "image/svg+xml" }))).toBe(
			"image.svg",
		);
		expect(attachmentFileName(block({ mime: "application/pdf" }))).toBe(
			"file.pdf",
		);
	});

	it("keeps a real file's own name", () => {
		expect(attachmentFileName(block({ name: "shot.png" }))).toBe("shot.png");
	});
});

describe("attachmentDetail", () => {
	it("leaves out what the agent did not report", () => {
		expect(
			attachmentDetail(block({ size: 443_000, width: 2000, height: 1333 })),
		).toBe("PNG · 2000×1333 · 433 KB");
		expect(attachmentDetail(block())).toBe("PNG");
	});
});

describe("omittedLabel", () => {
	it("speaks only for content that was left out", () => {
		expect(omittedLabel({ omitted: "too_large" })).toBe("Too large to preview");
		expect(omittedLabel({ omitted: "binary" })).toBe("Can't be previewed");
		expect(omittedLabel({ omitted: "unavailable" })).toBe("Not available");
		expect(omittedLabel({})).toBeNull();
	});
});
