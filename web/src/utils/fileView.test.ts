import { describe, expect, it } from "vitest";
import type { FileContent } from "../types/contents";
import {
	canEditFileView,
	formatMimeLabel,
	getEditLabel,
	getFileViewState,
	getImageSrc,
	getMimeType,
	HIGHLIGHT_LIMIT,
} from "./fileView";

function file(overrides: Partial<FileContent>): FileContent {
	return {
		name: "app.ts",
		type: "file",
		path: "src/app.ts",
		size: 10,
		mime: "text/plain; charset=utf-8",
		content: "hello",
		encoding: "text",
		...overrides,
	};
}

describe("getMimeType", () => {
	it("drops parameters", () => {
		expect(getMimeType("text/plain; charset=utf-8")).toBe("text/plain");
		expect(getMimeType("image/png")).toBe("image/png");
	});
});

describe("formatMimeLabel", () => {
	it("names the format without registry noise", () => {
		expect(formatMimeLabel("image/png")).toBe("PNG");
		expect(formatMimeLabel("image/jpeg")).toBe("JPEG");
		expect(formatMimeLabel("image/svg+xml")).toBe("SVG");
		expect(formatMimeLabel("image/x-icon")).toBe("ICON");
		expect(formatMimeLabel("image/vnd.microsoft.icon")).toBe("ICON");
		expect(formatMimeLabel("text/plain; charset=utf-8")).toBe("PLAIN");
	});
});

describe("getImageSrc", () => {
	it("wraps base64 content in a data URL", () => {
		expect(
			getImageSrc(
				file({ encoding: "base64", mime: "image/png", content: "AAAA" }),
			),
		).toBe("data:image/png;base64,AAAA");
	});

	it("percent-encodes SVG source", () => {
		const src = getImageSrc(
			file({
				encoding: "text",
				mime: "image/svg+xml",
				content: '<svg fill="#fff"/>',
			}),
		);
		expect(src).toBe("data:image/svg+xml,%3Csvg%20fill%3D%22%23fff%22%2F%3E");
	});
});

describe("getFileViewState", () => {
	it("reports omitted binary content", () => {
		expect(
			getFileViewState(
				file({
					encoding: "none",
					omitted: "binary",
					content: "",
					mime: "application/zip",
					size: 4096,
				}),
			),
		).toEqual({ kind: "binary", mime: "application/zip", size: 4096 });
	});

	it("reports oversized files with the server's limit", () => {
		expect(
			getFileViewState(
				file({
					encoding: "none",
					omitted: "too_large",
					content: "",
					mime: "text/plain; charset=utf-8",
					size: 5_000_000,
					limit: 2 << 20,
				}),
			),
		).toEqual({
			kind: "too-large",
			mime: "text/plain; charset=utf-8",
			size: 5_000_000,
			limit: 2 << 20,
		});
	});

	it("treats an oversized file as too-large regardless of its type", () => {
		const state = getFileViewState(
			file({
				encoding: "none",
				omitted: "too_large",
				content: "",
				mime: "image/png",
				size: 5_000_000,
			}),
		);
		expect(state.kind).toBe("too-large");
	});

	it("distinguishes an empty file from missing content", () => {
		expect(getFileViewState(file({ size: 0, content: "" }))).toEqual({
			kind: "empty",
		});
	});

	it("routes any image MIME to the image preview", () => {
		const png = getFileViewState(
			file({ encoding: "base64", mime: "image/png", content: "AAAA" }),
		);
		expect(png).toMatchObject({ kind: "image", mime: "image/png" });

		// SVG is the one image that arrives as text.
		const svg = getFileViewState(
			file({ mime: "image/svg+xml", content: "<svg/>" }),
		);
		expect(svg).toMatchObject({ kind: "image", mime: "image/svg+xml" });

		// Formats the old extension whitelist had no entry for.
		const avif = getFileViewState(
			file({ encoding: "base64", mime: "image/avif", content: "AAAA" }),
		);
		expect(avif.kind).toBe("image");
	});

	it("highlights text only up to the limit", () => {
		expect(getFileViewState(file({ size: HIGHLIGHT_LIMIT }))).toMatchObject({
			kind: "text",
			highlight: true,
		});
		expect(getFileViewState(file({ size: HIGHLIGHT_LIMIT + 1 }))).toMatchObject(
			{
				kind: "text",
				highlight: false,
			},
		);
	});

	it("measures the highlight limit in bytes, not code units", () => {
		// Half the limit in characters, but over it in UTF-8 bytes.
		const content = "中".repeat(HIGHLIGHT_LIMIT / 2);
		const state = getFileViewState(
			file({ content, size: content.length * 3, mime: "text/plain" }),
		);
		expect(state).toMatchObject({ kind: "text", highlight: false });
	});
});

describe("edit availability", () => {
	const state = (overrides: Partial<FileContent>) =>
		getFileViewState(file(overrides));

	const text = state({});
	const empty = state({ size: 0, content: "" });
	const png = state({ encoding: "base64", mime: "image/png", content: "AAAA" });
	const svg = state({ mime: "image/svg+xml", content: "<svg/>" });
	const binary = state({
		encoding: "none",
		omitted: "binary",
		mime: "application/zip",
	});
	const tooLarge = state({ encoding: "none", omitted: "too_large" });

	it("allows editing anything that arrived as text", () => {
		expect(canEditFileView(text)).toBe(true);
		expect(canEditFileView(empty)).toBe(true);
		// SVG is rendered as an image but is still source the editor can open,
		// and was editable before the viewer learned about images.
		expect(canEditFileView(svg)).toBe(true);
		expect(canEditFileView(png)).toBe(false);
		expect(canEditFileView(binary)).toBe(false);
		expect(canEditFileView(tooLarge)).toBe(false);
	});

	it("names the reason a file cannot be edited", () => {
		expect(getEditLabel(text)).toBe("Edit");
		expect(getEditLabel(svg)).toBe("Edit");
		expect(getEditLabel(png)).toMatch(/^Edit \(/);
		expect(getEditLabel(binary)).toMatch(/^Edit \(/);
		expect(getEditLabel(tooLarge)).toMatch(/^Edit \(/);
	});
});
