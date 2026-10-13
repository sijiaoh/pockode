import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

const SIZES: Record<string, [number, number]> = {
	"wide.png": [2000, 500],
	"tall.png": [400, 2000],
	"icon.png": [16, 16],
};

vi.mock("../../lib/wsStore", async (importOriginal) => {
	const module = await importOriginal<typeof import("../../lib/wsStore")>();
	const { actions } = module.useWSStore.getState();
	module.useWSStore.setState({
		workDir: "/work",
		actions: {
			...actions,
			getFile: async (path = "") => ({
				type: "file",
				file: {
					name: path,
					type: "file",
					path,
					size: 1,
					mime: "image/png",
					content: "",
					encoding: "http",
				},
			}),
		},
	});
	return module;
});

/** A real PNG of the size the path names, as the server would send it. */
async function png(url: string): Promise<Response> {
	const name = Object.keys(SIZES).find((key) => url.includes(key));
	if (!name) throw new Error(`no image at ${url}`);
	const [width, height] = SIZES[name];
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("no 2d context");
	context.fillRect(0, 0, width, height);
	return new Response(await canvas.convertToBlob({ type: "image/png" }));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

async function renderImage(name: string, width = 360) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => png(input)),
	);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<div style={{ width }}>
				<MarkdownContent content={`Screenshot:\n![${name}](${name})`} />
			</div>
		</QueryClientProvider>,
	);
	const image = await screen.findByRole("img", { name });
	await waitFor(() =>
		expect(screen.queryByRole("status", { name }), "still loading").toBeNull(),
	);
	return image.getBoundingClientRect();
}

/** What a press `dx` pixels right of the image's right edge lands on. */
function pressBeside(box: DOMRect, dx: number): Element | null {
	return document.elementFromPoint(box.right + dx, box.top + box.height / 2);
}

const REM = 16;

describe("a block Markdown image", () => {
	it("shrinks a wide image to the column, keeping its aspect", async () => {
		const box = await renderImage("wide.png");

		expect(box.width).toBeLessThanOrEqual(360);
		expect(box.width).toBeGreaterThan(340);
		expect(box.width / box.height).toBeCloseTo(4, 1);
	});

	it("caps a tall image's height, keeping its aspect", async () => {
		const box = await renderImage("tall.png");

		expect(box.height).toBeCloseTo(20 * REM, 0);
		expect(box.height / box.width).toBeCloseTo(5, 1);
	});

	it("never enlarges a small image", async () => {
		const box = await renderImage("icon.png");

		expect(box.width).toBe(16);
		expect(box.height).toBe(16);
	});

	// The frame clips the image to its corners; clipping on the button would
	// cut its hit area back to the 16px icon.
	it("gives a small image a hit area larger than itself", async () => {
		const box = await renderImage("icon.png");

		expect(pressBeside(box, 6)?.closest("button")).toHaveAccessibleName(
			"View icon.png",
		);
	});
});
