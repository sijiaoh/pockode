import { describe, expect, it } from "vitest";
import type { FileContent, ImageOrigin } from "../types/contents";
import {
	canEditFileView,
	formatMimeLabel,
	getEditLabel,
	getFileViewState,
	getImageSource,
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

const ORIGIN: ImageOrigin = { kind: "file", path: "src/app.ts" };

const view = (content: FileContent) => getFileViewState(content, ORIGIN);

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

describe("getImageSource", () => {
	it("reads a raster image from where it was described", () => {
		expect(
			getImageSource(
				file({ encoding: "http", mime: "image/png", content: "" }),
				ORIGIN,
			),
		).toEqual({ kind: "remote", origin: ORIGIN, mime: "image/png" });
	});

	it("percent-encodes SVG source", () => {
		const source = getImageSource(
			file({
				encoding: "text",
				mime: "image/svg+xml",
				content: '<svg fill="#fff"/>',
			}),
			ORIGIN,
		);
		// Never a Blob: an object URL would be same-origin with the app.
		expect(source).toEqual({
			kind: "inline",
			src: "data:image/svg+xml,%3Csvg%20fill%3D%22%23fff%22%2F%3E",
		});
	});
});

describe("getFileViewState", () => {
	it("reports omitted binary content", () => {
		expect(
			view(
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
			view(
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
		const state = view(
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
		expect(view(file({ size: 0, content: "" }))).toEqual({
			kind: "empty",
		});
	});

	it("routes any image MIME to the image preview", () => {
		const png = view(
			file({ encoding: "http", mime: "image/png", content: "" }),
		);
		expect(png).toMatchObject({ kind: "image", mime: "image/png" });

		// SVG is the one image that arrives as text.
		const svg = view(file({ mime: "image/svg+xml", content: "<svg/>" }));
		expect(svg).toMatchObject({ kind: "image", mime: "image/svg+xml" });

		// Formats the old extension whitelist had no entry for.
		const avif = view(
			file({ encoding: "http", mime: "image/avif", content: "" }),
		);
		expect(avif.kind).toBe("image");
	});

	it("keeps text typed as a raster image as text", () => {
		// A git-LFS pointer committed as photo.avif: typed from the extension,
		// but the server found text and sent it as such.
		const pointer = view(
			file({
				mime: "image/avif",
				content: "version https://git-lfs.github.com/spec/v1",
			}),
		);
		expect(pointer).toMatchObject({ kind: "text" });
	});

	it("highlights text only up to the limit", () => {
		expect(view(file({ size: HIGHLIGHT_LIMIT }))).toMatchObject({
			kind: "text",
			highlight: true,
		});
		expect(view(file({ size: HIGHLIGHT_LIMIT + 1 }))).toMatchObject({
			kind: "text",
			highlight: false,
		});
	});

	it("measures the highlight limit in bytes, not code units", () => {
		// Half the limit in characters, but over it in UTF-8 bytes.
		const content = "中".repeat(HIGHLIGHT_LIMIT / 2);
		const state = view(
			file({ content, size: content.length * 3, mime: "text/plain" }),
		);
		expect(state).toMatchObject({ kind: "text", highlight: false });
	});
});

describe("edit availability", () => {
	const state = (overrides: Partial<FileContent>) => view(file(overrides));

	const text = state({});
	const empty = state({ size: 0, content: "" });
	const png = state({ encoding: "http", mime: "image/png", content: "" });
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
