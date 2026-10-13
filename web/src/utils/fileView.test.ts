import { describe, expect, it } from "vitest";
import type { ContentOrigin, FileContent } from "../types/contents";
import {
	canEditFileView,
	formatMediaCaption,
	formatMimeLabel,
	getEditLabel,
	getFileViewState,
	getImageSource,
	getMimeType,
	getPlayableKind,
	HIGHLIGHT_LIMIT,
	inlineVideoBox,
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

const ORIGIN: ContentOrigin = { kind: "file", path: "src/app.ts" };

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
		expect(formatMimeLabel("video/quicktime")).toBe("MOV");
		expect(formatMimeLabel("audio/mpeg")).toBe("MP3");
	});
});

describe("formatMediaCaption", () => {
	it("says type, dimensions, length and size, in that order", () => {
		expect(
			formatMediaCaption("video/quicktime", 2048, {
				dimensions: { width: 1080, height: 1920 },
				duration: 42.7,
			}),
		).toBe("MOV · 1080×1920 · 0:42 · 2 KB");
		expect(formatMediaCaption("audio/mpeg", 2048, { duration: 192 })).toBe(
			"MP3 · 3:12 · 2 KB",
		);
		expect(formatMediaCaption("image/png", 2048)).toBe("PNG · 2 KB");
	});

	it("counts hours once there are any", () => {
		expect(formatMediaCaption("audio/mpeg", 2048, { duration: 3725 })).toBe(
			"MP3 · 1:02:05 · 2 KB",
		);
	});

	it("leaves out a length the file does not state", () => {
		for (const duration of [Number.POSITIVE_INFINITY, Number.NaN]) {
			expect(formatMediaCaption("video/webm", 2048, { duration })).toBe(
				"WEBM · 2 KB",
			);
		}
	});
});

describe("inlineVideoBox", () => {
	it("reserves 16:9 until the video says its shape", () => {
		expect(inlineVideoBox(null)).toEqual({
			aspectRatio: "16 / 9",
			width: "min(100%, calc(70vh * 16 / 9))",
		});
	});

	it("takes the video's shape, never wider than its own pixels", () => {
		expect(inlineVideoBox({ width: 1080, height: 1920 })).toEqual({
			aspectRatio: "1080 / 1920",
			width: "min(100%, 1080px, calc(70vh * 1080 / 1920))",
		});
	});
});

describe("getPlayableKind", () => {
	it("names the element that plays a type", () => {
		expect(getPlayableKind("audio/mpeg")).toBe("audio");
		expect(getPlayableKind("video/quicktime")).toBe("video");
		expect(getPlayableKind("video/mp4; codecs=avc1")).toBe("video");
		expect(getPlayableKind("image/png")).toBeNull();
		expect(getPlayableKind("application/ogg")).toBeNull();
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

	it("routes audio and video to a player, reading from the origin", () => {
		// Past the image ceiling: the server sends media of any size.
		const size = 100 * 1024 * 1024;
		expect(
			view(
				file({ encoding: "http", mime: "video/quicktime", content: "", size }),
			),
		).toEqual({ kind: "video", origin: ORIGIN, mime: "video/quicktime", size });
		expect(
			view(file({ encoding: "http", mime: "audio/mpeg", content: "" })),
		).toMatchObject({ kind: "audio", origin: ORIGIN });
	});

	it("keeps text typed as audio or video as text", () => {
		// A git-LFS pointer committed as clip.mov.
		const pointer = view(
			file({
				mime: "video/quicktime",
				content: "version https://git-lfs.github.com/spec/v1",
			}),
		);
		expect(pointer).toMatchObject({ kind: "text" });
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

	describe("HTML page", () => {
		const html = "text/html; charset=utf-8";

		it("renders HTML text as a page, with the text as its source", () => {
			const state = view(file({ mime: html, content: "<p>x</p>", size: 8 }));
			expect(state).toEqual({
				kind: "page",
				origin: ORIGIN,
				mime: html,
				size: 8,
				source: { kind: "text", content: "<p>x</p>", highlight: true },
			});
			expect(canEditFileView(state)).toBe(true);
		});

		it("renders a page too large to send, whose source cannot be edited", () => {
			const state = view(
				file({
					mime: html,
					encoding: "none",
					omitted: "too_large",
					content: "",
					size: 5_000_000,
					limit: 2_000_000,
				}),
			);
			expect(state).toMatchObject({
				kind: "page",
				source: { kind: "too-large", size: 5_000_000 },
			});
			expect(canEditFileView(state)).toBe(false);
			expect(getEditLabel(state)).toBe("Edit (file is too large to edit)");
		});

		it("leaves an attachment's HTML as text: it has no folder for assets", () => {
			const state = getFileViewState(file({ mime: html }), {
				kind: "attachment",
				sessionId: "s",
				id: "a",
				worktree: "",
			});
			expect(state.kind).toBe("text");
		});

		it("leaves an empty HTML file empty", () => {
			expect(view(file({ mime: html, content: "", size: 0 })).kind).toBe(
				"empty",
			);
		});
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
	const video = state({ encoding: "http", mime: "video/mp4", content: "" });

	it("allows editing anything that arrived as text", () => {
		expect(canEditFileView(text)).toBe(true);
		expect(canEditFileView(empty)).toBe(true);
		// SVG is rendered as an image but is still source the editor can open,
		// and was editable before the viewer learned about images.
		expect(canEditFileView(svg)).toBe(true);
		expect(canEditFileView(png)).toBe(false);
		expect(canEditFileView(binary)).toBe(false);
		expect(canEditFileView(tooLarge)).toBe(false);
		expect(canEditFileView(video)).toBe(false);
	});

	it("names the reason a file cannot be edited", () => {
		expect(getEditLabel(text)).toBe("Edit");
		expect(getEditLabel(svg)).toBe("Edit");
		expect(getEditLabel(png)).toMatch(/^Edit \(/);
		expect(getEditLabel(binary)).toMatch(/^Edit \(/);
		expect(getEditLabel(tooLarge)).toMatch(/^Edit \(/);
		expect(getEditLabel(video)).toMatch(/^Edit \(/);
	});
});
