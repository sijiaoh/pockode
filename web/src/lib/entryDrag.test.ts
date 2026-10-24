import { afterEach, describe, expect, it, vi } from "vitest";
import {
	canDragOutDownload,
	ENTRY_DRAG_TYPE,
	writeEntryDrag,
} from "./entryDrag";

function emptyDrag() {
	const data: Record<string, string> = {};
	return {
		effectAllowed: "uninitialized",
		data,
		setData(type: string, value: string) {
			data[type] = value;
		},
	};
}

function write(
	entry: { path: string; type: "file" | "dir"; name: string },
	url: string | null,
) {
	const drag = emptyDrag();
	writeEntryDrag(drag as unknown as DataTransfer, entry, url);
	return drag;
}

describe("writeEntryDrag", () => {
	it("saves a file under its own name when let go outside the browser", () => {
		const drag = write(
			{ path: "docs/a b.md", type: "file", name: "a b.md" },
			"/api/raw/cap/a%20b.md",
		);

		// Copy for the desktop, move for the tree.
		expect(drag.effectAllowed).toBe("copyMove");
		expect(drag.data.DownloadURL).toBe(
			`application/octet-stream:a b.md:${window.location.origin}/api/raw/cap/a%20b.md?download=1`,
		);
		expect(JSON.parse(drag.data[ENTRY_DRAG_TYPE])).toEqual({
			path: "docs/a b.md",
			type: "file",
		});
	});

	it("saves a folder as its zip", () => {
		const drag = write(
			{ path: "src", type: "dir", name: "src" },
			"/api/raw/cap/",
		);

		expect(drag.data.DownloadURL).toBe(
			`application/zip:src.zip:${window.location.origin}/api/raw/cap/?download=1`,
		);
	});

	it("only moves without a capability", () => {
		const drag = write({ path: "src", type: "dir", name: "src" }, null);

		expect(drag.effectAllowed).toBe("move");
		expect(Object.keys(drag.data)).toEqual([ENTRY_DRAG_TYPE]);
	});

	// The browser takes everything after the name's `:` as the URL.
	it("only moves an entry whose name has a colon in it", () => {
		const drag = write(
			{ path: "a:b.txt", type: "file", name: "a:b.txt" },
			"/api/raw/cap/a%3Ab.txt",
		);

		expect(drag.effectAllowed).toBe("move");
		expect(drag.data.DownloadURL).toBeUndefined();
	});
});

describe("canDragOutDownload", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubNavigator(
		userAgent: string,
		brands?: { brand: string; version: string }[],
	) {
		vi.stubGlobal("navigator", {
			userAgent,
			...(brands && { userAgentData: { brands } }),
		});
	}

	it("trusts the brands where the browser lists them", () => {
		stubNavigator("Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36", [
			{ brand: "Not.A/Brand", version: "99" },
			{ brand: "Chromium", version: "150" },
		]);
		expect(canDragOutDownload()).toBe(true);
	});

	// Over plain HTTP `userAgentData` is withheld.
	it("falls back to the user agent string", () => {
		stubNavigator(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
		);
		expect(canDragOutDownload()).toBe(true);
	});

	it.each([
		[
			"Firefox",
			"Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0",
		],
		[
			"Safari",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
		],
	])("is off in %s", (_name, userAgent) => {
		stubNavigator(userAgent);
		expect(canDragOutDownload()).toBe(false);
	});
});
