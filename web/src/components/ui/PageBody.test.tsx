import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useSearch,
} from "@tanstack/react-router";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import {
	ScrollRestorationContext,
	useScrollRestorationScope,
} from "../../hooks/useScrollRestoration";
import { scrollMemoryFor } from "../../lib/scrollMemory";
import { stubScrollBox } from "../../test/scrollBox";
import PageBody from "./PageBody";

// The app shell's part, without the rest of the shell.
function Shell() {
	return (
		<ScrollRestorationContext value={useScrollRestorationScope()}>
			<Outlet />
		</ScrollRestorationContext>
	);
}

/** The ref `/own` keeps to its scroller, as a page that drives it would. */
const ownRef = createRef<HTMLDivElement>();

function page(name: string) {
	return () => (
		<PageBody ref={name === "own" ? ownRef : undefined}>
			<p>{name} page</p>
		</PageBody>
	);
}

/**
 * One view for every document, as the file view is: going from one to the
 * next re-renders it rather than mounting another.
 */
function Doc() {
	const { name } = useSearch({ strict: false }) as { name?: string };
	return (
		<PageBody>
			<p>doc page</p>
			<p>{name}</p>
		</PageBody>
	);
}

/**
 * `/slow` is a page whose route waits on `loading` before it is shown, which
 * holds the page being left on screen after the router's location has moved.
 */
function renderPages(initial = "/commit", loading?: Promise<void>) {
	const root = createRootRoute({ component: Shell });
	const router = createRouter({
		routeTree: root.addChildren([
			...["commit", "diff", "history", "own"].map((name) =>
				createRoute({
					getParentRoute: () => root,
					path: `/${name}`,
					component: page(name),
				}),
			),
			createRoute({
				getParentRoute: () => root,
				path: "/doc",
				component: Doc,
			}),
			createRoute({
				getParentRoute: () => root,
				path: "/slow",
				loader: () => loading,
				component: page("slow"),
			}),
		]),
		history: createMemoryHistory({ initialEntries: [initial] }),
	});
	// As the app's router does, so the trail starts before the first push.
	scrollMemoryFor(router.history);
	render(<RouterProvider router={router} />);
	return router;
}

/** The page's scroller, given a height to scroll in — its content arriving. */
async function scrollerOf(name: string): Promise<HTMLElement> {
	const scroller = (await screen.findByText(`${name} page`)).parentElement;
	if (!scroller) throw new Error(`no scroller for ${name}`);
	stubScrollBox(scroller, { contentHeight: 3000, viewportHeight: 600 });
	return scroller;
}

function scrollTo(scroller: HTMLElement, top: number) {
	scroller.scrollTop = top;
	fireEvent.scroll(scroller);
}

// `to` as a string: these routes are not the app's, which are the ones the
// router's types are registered with.
function navigate(
	router: ReturnType<typeof renderPages>,
	to: string,
	replace = false,
) {
	return router.navigate({ to, replace });
}

async function go(router: ReturnType<typeof renderPages>, to: string) {
	await act(() => navigate(router, to));
}

describe("PageBody", () => {
	it("is back where it was left after the browser's Back", async () => {
		const router = renderPages();
		scrollTo(await scrollerOf("commit"), 1200);
		await go(router, "/diff");

		await act(async () => router.history.back());
		// The content arrives after the page does, as a read answering would.
		const scroller = await scrollerOf("commit");
		await expect.poll(() => scroller.scrollTop).toBe(1200);
	});

	it("is back where it was left after the header's Back", async () => {
		const router = renderPages();
		scrollTo(await scrollerOf("commit"), 1200);
		await go(router, "/diff");

		await go(router, "/commit");
		const scroller = await scrollerOf("commit");
		await expect.poll(() => scroller.scrollTop).toBe(1200);
	});

	it("fills a page's own ref to its scroller and still restores it", async () => {
		const router = renderPages("/own");
		const own = await scrollerOf("own");
		expect(ownRef.current).toBe(own);
		scrollTo(own, 1200);
		await go(router, "/diff");
		expect(ownRef.current).toBeNull();

		await act(async () => router.history.back());
		const scroller = await scrollerOf("own");
		expect(ownRef.current).toBe(scroller);
		await expect.poll(() => scroller.scrollTop).toBe(1200);
	});

	it("is back where it was left on a page that stayed mounted", async () => {
		const router = renderPages("/doc?name=a");
		const scroller = await scrollerOf("doc");
		scrollTo(scroller, 1200);
		await go(router, "/doc?name=b");
		expect(await screen.findByText("b")).toBeInTheDocument();
		scrollTo(scroller, 300);

		await act(async () => router.history.back());
		expect(await screen.findByText("a")).toBeInTheDocument();
		await expect.poll(() => scroller.scrollTop).toBe(1200);
	});

	it("starts a page that stayed mounted at the top on a fresh visit, but not on a replace", async () => {
		const router = renderPages("/doc?name=a");
		const scroller = await scrollerOf("doc");
		scrollTo(scroller, 1200);
		await act(() => navigate(router, "/doc?name=c", true));
		expect(await screen.findByText("c")).toBeInTheDocument();
		await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
		expect(scroller.scrollTop).toBe(1200);

		await go(router, "/doc?name=b");
		expect(await screen.findByText("b")).toBeInTheDocument();
		await expect.poll(() => scroller.scrollTop).toBe(0);
	});

	it("starts a fresh visit at the top", async () => {
		const router = renderPages("/history");
		await go(router, "/commit");
		scrollTo(await scrollerOf("commit"), 1200);
		// The header's Back to the list, and the same commit opened again.
		await go(router, "/history");
		await go(router, "/commit");
		const scroller = await scrollerOf("commit");
		// Long enough for a restore to have landed, had one been started.
		await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
		expect(scroller.scrollTop).toBe(0);
	});

	it("leaves the page to a reader who scrolls before the content arrives", async () => {
		const router = renderPages();
		scrollTo(await scrollerOf("commit"), 1200);
		await go(router, "/diff");
		await act(async () => router.history.back());

		const scroller = (await screen.findByText("commit page")).parentElement;
		if (!scroller) throw new Error("no scroller");
		fireEvent.touchStart(scroller);
		stubScrollBox(scroller, { contentHeight: 3000, viewportHeight: 600 });
		await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
		expect(scroller.scrollTop).toBe(0);
	});

	it("leaves the page to a control outside it pressed before the content arrives", async () => {
		const router = renderPages();
		scrollTo(await scrollerOf("commit"), 1200);
		await go(router, "/diff");
		await act(async () => router.history.back());

		const scroller = (await screen.findByText("commit page")).parentElement;
		if (!scroller) throw new Error("no scroller");
		// A pager or a jump button beside the scroller, moving it itself.
		fireEvent.pointerDown(document.body);
		stubScrollBox(scroller, { contentHeight: 3000, viewportHeight: 600 });
		await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
		expect(scroller.scrollTop).toBe(0);
	});

	it("keeps a scroll made while the next page loads for the page it was made on", async () => {
		let loaded = () => {};
		const loading = new Promise<void>((resolve) => {
			loaded = resolve;
		});
		const router = renderPages("/commit", loading);
		const commit = await scrollerOf("commit");

		let navigation: Promise<void> = Promise.resolve();
		act(() => {
			navigation = navigate(router, "/slow");
		});
		// The router is on the next entry; the commit is still on screen.
		await waitFor(() => expect(router.state.location.pathname).toBe("/slow"));
		expect(screen.getByText("commit page")).toBeInTheDocument();
		scrollTo(commit, 1200);

		await act(async () => {
			loaded();
			await navigation;
		});
		const slow = await scrollerOf("slow");
		await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
		expect(slow.scrollTop).toBe(0);

		await act(async () => router.history.back());
		const back = await scrollerOf("commit");
		await expect.poll(() => back.scrollTop).toBe(1200);
	});
});
