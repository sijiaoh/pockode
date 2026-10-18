import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createBrowserHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent as realUserEvent } from "vitest/browser";
import { useWSStore, wsActions } from "../../lib/wsStore";
// A 64×36 VP9 clip, served by the test server as a capability path would be.
import clipPath from "../../test/clip-64x36.webm?url";
// A page linking to a second one beside it, served the same way: their folder
// stands for a root capability, with the page at its root.
import pagePath from "../../test/page/index.htm?url";
import { MediaViewer } from "./MediaViewer";
import type { HtmlMediaItem, ImageMediaItem, VideoMediaItem } from "./types";

// Gestures are asserted on where the image lands on screen, read from real
// layout: its box at fit against the frame, and its drawn size against that
// box for the scale. Positions differ between browsers and window sizes, so
// every expectation is relative to the frame the test measured.

const BIG = { width: 3000, height: 2000 };
const SMALL = { width: 60, height: 40 };

function pngDataUrl({ width, height }: { width: number; height: number }) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (context) {
		context.fillStyle = "#3b82f6";
		context.fillRect(0, 0, width, height);
	}
	return canvas.toDataURL("image/png");
}

function imageItem(name: string, size: typeof BIG): ImageMediaItem {
	return {
		kind: "image",
		name,
		saveAs: name,
		mime: "image/png",
		size: 1024,
		source: { kind: "inline", src: pngDataUrl(size) },
	};
}

async function openViewer(item: ImageMediaItem) {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MediaViewer item={item} onClose={vi.fn()} />
		</QueryClientProvider>,
	);
	const image = await screen.findByRole("img", { name: item.name });
	// The readout appears once the image has decoded and been laid out.
	await screen.findByRole("button", { name: /^Zoom: Fit/ });
	const frame = screen.getByRole("region", { name: item.name });
	const wrapper = image.closest<HTMLElement>(".react-transform-wrapper");
	if (!wrapper) throw new Error("no transform wrapper");
	return { image, frame, wrapper };
}

/**
 * The image's size at fit — its layout box, which the transform leaves alone.
 * Read from the computed style, since `offsetWidth` rounds to whole pixels and
 * at actual size the transform multiplies that error several times over.
 */
function fitOf(image: HTMLElement) {
	const style = getComputedStyle(image);
	return { width: parseFloat(style.width), height: parseFloat(style.height) };
}

function scaleOf(image: HTMLElement): number {
	return image.getBoundingClientRect().width / fitOf(image).width;
}

type Box = { left: number; top: number; width: number; height: number };

function boxOf(element: HTMLElement): Box {
	const { left, top, width, height } = element.getBoundingClientRect();
	return { left, top, width, height };
}

/**
 * The image's box if it holds still from one animation frame to the next, or
 * null while it moves — "stable" as Playwright's actionability checks mean it.
 * Being near a target is not being at rest: an animation's last frames are
 * already close to where it ends, and still moving.
 */
async function stillBoxOf(image: HTMLElement): Promise<Box | null> {
	const before = boxOf(image);
	await new Promise(requestAnimationFrame);
	const after = boxOf(image);
	const still = (Object.keys(after) as (keyof Box)[]).every(
		(side) => before[side] === after[side],
	);
	return still ? after : null;
}

/**
 * Waits for the transform to come to rest at `scale`. Rest alone is not
 * enough: before an animation's first frame the image is still at rest where
 * it was.
 */
async function settlesAt(image: HTMLElement, scale: number) {
	const width = fitOf(image).width;
	await expect
		.poll(async () => {
			const box = await stillBoxOf(image);
			return box && box.width / width;
		})
		.toBeCloseTo(scale, 2);
}

/** Waits for the image to come to rest at `box`, to within half a pixel. */
async function restsAt(image: HTMLElement, box: Box) {
	await expect
		.poll(() => stillBoxOf(image))
		.toEqual({
			left: expect.closeTo(box.left, 0),
			top: expect.closeTo(box.top, 0),
			width: expect.closeTo(box.width, 0),
			height: expect.closeTo(box.height, 0),
		});
}

/** Waits for the image to come to rest wherever that is, and says where. */
function restingBoxOf(image: HTMLElement): Promise<Box> {
	return vi.waitFor(async () => {
		const box = await stillBoxOf(image);
		if (!box) throw new Error("the image is still moving");
		return box;
	});
}

function centre(element: HTMLElement) {
	const rect = element.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function mouse(target: EventTarget, type: string, x: number, y: number) {
	target.dispatchEvent(
		new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: x,
			clientY: y,
			button: 0,
			buttons: type === "mouseup" ? 0 : 1,
		}),
	);
}

function wheel(target: HTMLElement, init: WheelEventInit) {
	const { x, y } = centre(target);
	target.dispatchEvent(
		new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			clientX: x,
			clientY: y,
			...init,
		}),
	);
}

/**
 * A touch event carrying `points`. Built by hand: WebKit on the desktop has no
 * `Touch` constructor, and the library reads only the coordinates.
 */
function touch(target: HTMLElement, type: string, points: [number, number][]) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "touches", {
		value: points.map(([x, y]) => ({
			clientX: x,
			clientY: y,
			pageX: x,
			pageY: y,
		})),
	});
	target.dispatchEvent(event);
}

function pinch(target: HTMLElement, from: number, to: number) {
	const { x, y } = centre(target);
	const at = (gap: number): [number, number][] => [
		[x - gap / 2, y],
		[x + gap / 2, y],
	];
	touch(target, "touchstart", at(from));
	for (let step = 1; step <= 10; step++) {
		touch(target, "touchmove", at(from + ((to - from) * step) / 10));
	}
	touch(target, "touchend", []);
}

function tap(target: HTMLElement, x: number, y: number) {
	const init = {
		bubbles: true,
		cancelable: true,
		pointerType: "touch",
		pointerId: 7,
		clientX: x,
		clientY: y,
	};
	target.dispatchEvent(new PointerEvent("pointerdown", init));
	target.dispatchEvent(new PointerEvent("pointerup", init));
}

describe("MediaViewer image stage", () => {
	afterEach(async () => {
		await page.viewport(414, 896);
	});

	it("lays the image out contained in the frame and centred", async () => {
		const { image, frame } = await openViewer(imageItem("big.png", BIG));
		const box = frame.getBoundingClientRect();

		expect(image.offsetWidth).toBeLessThanOrEqual(box.width + 0.5);
		expect(image.offsetHeight).toBeLessThanOrEqual(box.height + 0.5);
		// Contained: one axis touches the frame's edges.
		expect(
			Math.min(
				Math.abs(image.offsetWidth - box.width),
				Math.abs(image.offsetHeight - box.height),
			),
		).toBeLessThan(1);
		// Centred by the library once its observer sees the laid-out size,
		// which is before the next paint but can be after the readout appears.
		await expect.poll(() => centre(image).x).toBeCloseTo(centre(frame).x, 0);
		await expect.poll(() => centre(image).y).toBeCloseTo(centre(frame).y, 0);
	});

	it("never enlarges a small image to fit", async () => {
		const { image } = await openViewer(imageItem("small.png", SMALL));
		expect(image.offsetWidth).toBe(SMALL.width);
	});

	it("double-click toggles between fit and actual size", async () => {
		const { image, wrapper } = await openViewer(imageItem("big.png", BIG));
		const { x, y } = centre(wrapper);

		mouse(wrapper, "dblclick", x, y);
		await expect
			.poll(() => image.getBoundingClientRect().width)
			.toBeCloseTo(BIG.width, -1);
		// The label follows the scale a render later; under load, after the poll.
		expect(
			await screen.findByRole("button", { name: /^Zoom: 100%/ }),
		).toBeVisible();

		mouse(wrapper, "dblclick", x, y);
		await settlesAt(image, 1);
	});

	it("double-click takes an image already near actual size to 2×", async () => {
		const { image, wrapper } = await openViewer(imageItem("small.png", SMALL));
		const { x, y } = centre(wrapper);

		mouse(wrapper, "dblclick", x, y);
		await settlesAt(image, 2);
	});

	it("a touch double-tap toggles too", async () => {
		const { image, wrapper } = await openViewer(imageItem("big.png", BIG));
		const { x, y } = centre(wrapper);

		tap(wrapper, x, y);
		tap(wrapper, x + 5, y + 5);
		await expect.poll(() => scaleOf(image)).toBeGreaterThan(1.5);
	});

	it("pinching springs back to fit below it and stops at the ceiling above it", async () => {
		const { image, wrapper } = await openViewer(imageItem("big.png", BIG));
		const actual = BIG.width / fitOf(image).width;
		const ceiling = Math.max(4, actual * 4);

		pinch(wrapper, 200, 40);
		await settlesAt(image, 1);

		pinch(wrapper, 20, 4000);
		await expect.poll(() => scaleOf(image)).toBeGreaterThan(2);
		await expect.poll(() => scaleOf(image)).toBeLessThanOrEqual(ceiling + 0.01);
	});

	it("panning stops at the image's edge", async () => {
		const { image, frame, wrapper } = await openViewer(
			imageItem("big.png", BIG),
		);
		const user = userEvent.setup();
		await user.keyboard("1");
		await expect
			.poll(() => image.getBoundingClientRect().width)
			.toBeCloseTo(BIG.width, -1);

		// Dragging far to the right would pull the left edge into the frame.
		const { x, y } = centre(wrapper);
		mouse(wrapper, "mousedown", x, y);
		for (let step = 1; step <= 10; step++) {
			mouse(window, "mousemove", x + step * 500, y);
		}
		mouse(window, "mouseup", x + 5000, y);

		await expect
			.poll(() => image.getBoundingClientRect().left)
			.toBeCloseTo(frame.getBoundingClientRect().left, 0);
	});

	it("ctrl+wheel zooms, and a plain wheel pans without zooming", async () => {
		const { image, wrapper } = await openViewer(imageItem("big.png", BIG));

		wheel(wrapper, { deltaY: 100 });
		expect(scaleOf(image)).toBeCloseTo(1, 2);

		for (let i = 0; i < 5; i++) wheel(wrapper, { deltaY: -100, ctrlKey: true });
		await expect.poll(() => scaleOf(image)).toBeGreaterThan(1.2);
		const { left, width } = await restingBoxOf(image);
		const zoomed = width / fitOf(image).width;

		wheel(wrapper, { deltaX: 80, deltaY: 0 });
		await expect
			.poll(() => image.getBoundingClientRect().left)
			.toBeLessThan(left - 10);
		expect(scaleOf(image)).toBeCloseTo(zoomed, 2);
	});

	it("keys zoom and pan", async () => {
		const { image, frame, wrapper } = await openViewer(
			imageItem("big.png", BIG),
		);
		const fit = fitOf(image);
		const actual = BIG.width / fit.width;
		const user = userEvent.setup();
		expect(frame).toHaveFocus();

		// Every zoom here is about the frame's centre and starts centred, so it
		// ends centred: larger than the frame the bounds leave it there, smaller
		// it is centred anyway. A pan then moves it by a tenth of the frame. The
		// library keeps a zoom's scale to two decimals, so actual size is drawn
		// a pixel or so off the image's own width.
		const view = wrapper.getBoundingClientRect();
		const at = (scale: number, panned = 0): Box => {
			const drawn = Math.round(scale * 100) / 100;
			const width = fit.width * drawn;
			const height = fit.height * drawn;
			return {
				left: view.left + (view.width - width) / 2 - panned,
				top: view.top + (view.height - height) / 2,
				width,
				height,
			};
		};

		// The library centres the image a few frames after the readout appears,
		// and a key pressed before that zooms from wherever it was.
		await restsAt(image, at(1));
		for (const [key, scale] of [
			["1", actual],
			["0", 1],
			["+", 1.5],
			["-", 1],
			["1", actual],
		] as const) {
			await user.keyboard(key);
			await restsAt(image, at(scale));
		}
		await user.keyboard("{ArrowRight}");
		await restsAt(image, at(actual, view.width * 0.1));
	});

	it("takes the keys back after a press on the image", async () => {
		const { image, frame, wrapper } = await openViewer(
			imageItem("big.png", BIG),
		);
		const user = userEvent.setup();
		screen.getByRole("button", { name: "Save" }).focus();

		// The library cancels this press to start a pan, and with it the
		// focus the press would have moved.
		const { x, y } = centre(wrapper);
		wrapper.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerType: "mouse",
				clientX: x,
				clientY: y,
			}),
		);
		mouse(wrapper, "mousedown", x, y);
		mouse(window, "mouseup", x, y);
		expect(frame).toHaveFocus();

		await user.keyboard("+");
		await settlesAt(image, 1.5);
	});

	it("refits the image when the frame is resized", async () => {
		const { image, frame } = await openViewer(imageItem("big.png", BIG));

		await page.viewport(800, 500);
		await expect
			.poll(() => {
				const box = frame.getBoundingClientRect();
				return Math.min(
					Math.abs(image.offsetWidth - box.width),
					Math.abs(image.offsetHeight - box.height),
				);
			})
			.toBeLessThan(1);
		expect(image.offsetHeight).toBeLessThanOrEqual(
			frame.getBoundingClientRect().height + 0.5,
		);
		await settlesAt(image, 1);
	});
});

describe("MediaViewer video stage", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fits a small clip to the frame, enlarging it, with the controls along the frame", async () => {
		useWSStore.setState({ status: "connected" });
		vi.spyOn(wsActions, "rawCapability").mockResolvedValue({
			path: clipPath,
			expiresAt: Date.now() + 60 * 60 * 1000,
			worktree: "",
		});
		const item: VideoMediaItem = {
			kind: "video",
			name: "clip.webm",
			saveAs: "clip.webm",
			mime: "video/webm",
			size: 1342,
			origin: { kind: "file", path: "clip.webm" },
		};
		render(
			<QueryClientProvider client={new QueryClient()}>
				<MediaViewer item={item} onClose={vi.fn()} />
			</QueryClientProvider>,
		);

		const video = (await screen.findByLabelText("clip.webm", {
			selector: "video",
		})) as HTMLVideoElement;
		// A real fetch and decode, which a loaded machine stretches past the
		// default second.
		await expect.poll(() => video.videoWidth, { timeout: 5_000 }).toBe(64);
		// The caption takes the size the stage reported.
		await screen.findByText(/64×36/);

		// The element spans the frame, so the native controls run along all of
		// its bottom edge, and `object-contain` draws the picture as large as
		// the frame allows — far past the clip's own 64px.
		const frame = screen.getByRole("region", { name: "clip.webm" });
		const box = frame.getBoundingClientRect();
		const drawn = video.getBoundingClientRect();
		expect(drawn.width).toBeCloseTo(box.width, 0);
		expect(drawn.height).toBeCloseTo(box.height, 0);
		expect(getComputedStyle(video).objectFit).toBe("contain");
		expect(Math.min(box.width / 64, box.height / 36)).toBeGreaterThan(2);
	});
});

describe("MediaViewer html stage", () => {
	const item: HtmlMediaItem = {
		kind: "html",
		name: "index.htm",
		saveAs: "index.htm",
		mime: "text/html",
		size: 64,
		origin: { kind: "file", path: "index.htm" },
	};
	const cleanups: (() => void)[] = [];

	afterEach(async () => {
		// Closed here, while the router still listens: unmounted by the global
		// cleanup instead, it would go back after the next test has pushed its
		// own entries.
		const close = screen.queryByRole("button", { name: "Close" });
		if (close) {
			const closed = popped();
			await userEvent.click(close);
			await closed;
		}
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * The viewer open over a page of the app, on the window's own history as
	 * in the app, with an entry before the page's to tell where Back lands.
	 */
	async function openOverHistory() {
		useWSStore.setState({ status: "connected" });
		vi.spyOn(wsActions, "rawCapability").mockResolvedValue({
			path: pagePath.slice(0, pagePath.lastIndexOf("/") + 1),
			expiresAt: Date.now() + 60 * 60 * 1000,
			worktree: "",
		});
		const entry = (tag: string, index: number) => ({
			tag,
			key: tag,
			__TSR_key: tag,
			__TSR_index: index,
		});
		window.history.pushState(entry("before", 0), "");
		window.history.pushState(entry("opener", 1), "");

		function Opener() {
			const [open, setOpen] = useState(true);
			return open ? (
				<MediaViewer item={item} onClose={() => setOpen(false)} />
			) : (
				<p>closed</p>
			);
		}
		const history = createBrowserHistory();
		cleanups.push(() => history.destroy());
		const router = createRouter({
			routeTree: createRootRoute({ component: Opener }),
			history,
		});
		render(
			<QueryClientProvider client={new QueryClient()}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);
		const frame = await screen.findByTitle<HTMLIFrameElement>("index.htm");
		await expect.poll(() => window.history.state?.fullScreen).toBeTruthy();
		// ↻ spins until the page's first load. A navigation before the page
		// has finished loading is made a replace, so give it a moment more.
		const reload = screen.getByRole("button", { name: "Reload page" });
		await expect
			.poll(() => reload.querySelector(".animate-spin"), { timeout: 5_000 })
			.toBeNull();
		await settle();
		return frame;
	}

	/**
	 * The window's state once a traversal changes its entry; "no popstate" if
	 * none does, as a Back onto an entry of a frame no longer there.
	 */
	function popped() {
		return new Promise<unknown>((resolve) => {
			const timer = setTimeout(() => resolve("no popstate"), 3_000);
			window.addEventListener(
				"popstate",
				() => {
					clearTimeout(timer);
					resolve(window.history.state);
				},
				{ once: true },
			);
		});
	}

	function settle() {
		return new Promise((resolve) => setTimeout(resolve, 200));
	}

	/** The wrapper saying the page in it has loaded (`rawPageWrapper`). */
	function loaded(frame: HTMLIFrameElement) {
		return new Promise<void>((resolve) => {
			const onMessage = (event: MessageEvent) => {
				if (
					event.source === frame.contentWindow &&
					event.data?.type === "pockode:page-loaded"
				) {
					window.removeEventListener("message", onMessage);
					resolve();
				}
			};
			window.addEventListener("message", onMessage);
		});
	}

	it("closes with ✕ onto the opener's entry after the page navigated, so one Back leaves it", async () => {
		const frame = await openOverHistory();
		// As a link followed in the page would: an entry each.
		const before = window.history.length;
		for (const name of ["next.htm", "index.htm", "next.htm"]) {
			const landed = loaded(frame);
			// The page's own frame, inside the wrapper the stage holds.
			const page = frame.contentWindow?.[0];
			if (page)
				page.location.href = new URL(name, location.origin + pagePath).href;
			await landed;
			await settle();
		}
		expect(window.history.length).toBe(before + 3);

		const closed = popped();
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(await closed).toMatchObject({ tag: "opener" });
		expect(await screen.findByText("closed")).toBeInTheDocument();

		const left = popped();
		window.history.back();
		expect(await left).toMatchObject({ tag: "before" });
	});

	it("keeps Tab in the sheet past the page's last element", async () => {
		const frame = await openOverHistory();
		frame.focus();
		// The page's link, then out of the page.
		await realUserEvent.keyboard("{Tab}");
		await realUserEvent.keyboard("{Tab}");

		await expect
			.poll(() => document.activeElement)
			.toBe(screen.getByRole("button", { name: "Close" }));
	});

	it("takes Shift+Tab from the sheet's first control round into the page", async () => {
		const frame = await openOverHistory();
		screen.getByRole("button", { name: "Close" }).focus();
		await realUserEvent.keyboard("{Shift>}{Tab}{/Shift}");

		await expect.poll(() => document.activeElement).toBe(frame);
	});
});
