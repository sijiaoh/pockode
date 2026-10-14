import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Refusals } from "../../lib/pageHosts";
import { PageHostsStrip, PRESS_HOLD_MS } from "./PageHostsStrip";

function refusals(...hosts: string[]): Refusals {
	return {
		hosts: hosts.map((host) => ({
			host: host.replace(" !", ""),
			allowable: !host.endsWith(" !"),
		})),
		overflow: false,
	};
}

let now = 0;

function renderStrip(props: Partial<ComponentProps<typeof PageHostsStrip>>) {
	const handlers = {
		onLoad: vi.fn(),
		onReload: vi.fn(),
		onOpenLink: vi.fn(),
	};
	const all = {
		refusals: refusals(),
		allowed: new Set<string>(),
		link: null,
		left: null,
		...handlers,
		...props,
	};
	const view = render(<PageHostsStrip {...all} />);
	return {
		...handlers,
		rerender: (next: Partial<ComponentProps<typeof PageHostsStrip>>) =>
			view.rerender(<PageHostsStrip {...all} {...next} />),
	};
}

// The press hold reads the clock; each test moves it past the hold by hand.
function pastHold() {
	now += PRESS_HOLD_MS + 1;
}

describe("PageHostsStrip", () => {
	beforeEach(() => {
		now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
	});
	afterEach(() => vi.restoreAllMocks());

	it("says nothing about a page that was refused nothing", () => {
		renderStrip({});

		expect(screen.queryByRole("group")).toBeNull();
	});

	it("offers to load exactly the hosts it names", async () => {
		const user = userEvent.setup();
		const { onLoad } = renderStrip({
			refusals: refusals("cdn.example", "fonts.example"),
		});
		pastHold();

		const strip = screen.getByRole("group", { name: "Hosts not loaded" });
		expect(strip).toHaveTextContent("Not loaded · cdn.example, fonts.example");
		await user.click(
			within(strip).getByRole("button", {
				name: "Load cdn.example, fonts.example and reload the page",
			}),
		);

		expect(onLoad).toHaveBeenCalledWith(["cdn.example", "fonts.example"]);
	});

	it("lists a host it cannot allow, and never loads it", async () => {
		const user = userEvent.setup();
		const { onLoad, rerender } = renderStrip({
			refusals: refusals("app.test !"),
		});

		expect(screen.getByRole("group")).toHaveTextContent(
			"Not loaded · app.test (can't be allowed)",
		);
		expect(screen.queryByRole("button")).toBeNull();

		rerender({ refusals: refusals("app.test !", "cdn.example") });
		pastHold();
		await user.click(screen.getByRole("button", { name: /^Load/ }));
		expect(onLoad).toHaveBeenCalledWith(["cdn.example"]);
	});

	it("says a host the page's policy names was refused anyway, without offering it", () => {
		renderStrip({
			refusals: {
				hosts: [{ host: "cdn.example", allowable: false, inPolicy: true }],
				overflow: false,
			},
			allowed: new Set(["cdn.example"]),
		});

		expect(screen.getByRole("group")).toHaveTextContent(
			"Not loaded · cdn.example (allowed, still refused)",
		);
		expect(screen.queryByRole("button")).toBeNull();
	});

	// A host the page reports a moment before the tap would otherwise be
	// allowed without the reader having seen it.
	it("ignores a press right after the list changes", async () => {
		const user = userEvent.setup();
		const { onLoad, rerender } = renderStrip({
			refusals: refusals("cdn.example"),
		});
		pastHold();

		rerender({ refusals: refusals("cdn.example", "collector.example") });
		const load = screen.getByRole("button", {
			name: "Load cdn.example, collector.example and reload the page",
		});
		await user.click(load);
		expect(onLoad).not.toHaveBeenCalled();

		pastHold();
		await user.click(load);
		expect(onLoad).toHaveBeenCalledWith(["cdn.example", "collector.example"]);
	});

	it("puts four or more hosts behind Review, which lists every one it loads", async () => {
		const user = userEvent.setup();
		const { onLoad } = renderStrip({
			refusals: {
				...refusals("a.example", "b.example", "c.example", "d.example"),
				overflow: true,
			},
		});
		pastHold();

		const strip = screen.getByRole("group");
		expect(strip).toHaveTextContent(
			"Not loaded · a.example, b.example and 2 more",
		);
		expect(within(strip).queryByRole("button", { name: /Load/ })).toBeNull();

		await user.click(within(strip).getByRole("button", { name: "Review" }));
		// Opening the list puts Load all under the finger: held afresh.
		pastHold();
		const list = within(strip).getByRole("list");
		expect(within(list).getAllByRole("listitem")).toHaveLength(4);
		expect(strip).toHaveTextContent(
			"More hosts were refused and aren't listed.",
		);
		expect(strip).toHaveTextContent("Loading reloads the page.");
		await user.click(
			within(strip).getByRole("button", {
				name: "Load all 4 hosts and reload the page",
			}),
		);
		expect(onLoad).toHaveBeenCalledWith([
			"a.example",
			"b.example",
			"c.example",
			"d.example",
		]);
	});

	// A frame left behind — the card under full screen — keeps the document
	// the reader left, and offers to reload into the allowance instead.
	it("offers a reload for hosts allowed since the page was drawn", async () => {
		const user = userEvent.setup();
		const { onReload, onLoad } = renderStrip({
			refusals: refusals("cdn.example"),
			allowed: new Set(["cdn.example"]),
		});

		const strip = screen.getByRole("group");
		expect(strip).toHaveTextContent("Allowed · cdn.example");
		await user.click(
			within(strip).getByRole("button", {
				name: "Reload the page to load cdn.example",
			}),
		);
		expect(onReload).toHaveBeenCalled();
		expect(onLoad).not.toHaveBeenCalled();
	});

	it("offers a link the app could not open, by its host", async () => {
		const user = userEvent.setup();
		const { onOpenLink } = renderStrip({ link: { host: "docs.example" } });
		pastHold();

		expect(screen.getByRole("group")).toHaveTextContent(
			"Link not opened · docs.example",
		);
		await user.click(
			screen.getByRole("button", { name: "Open link to docs.example" }),
		);
		expect(onOpenLink).toHaveBeenCalled();
	});

	it("says the page left, in place of the rest, and offers nothing to open", () => {
		renderStrip({
			refusals: refusals("cdn.example"),
			link: { host: "docs.example" },
			left: { host: "collector.example" },
		});

		const strip = screen.getByRole("group");
		expect(strip).toHaveTextContent("Page left · collector.example");
		expect(
			within(strip)
				.getAllByRole("button")
				.map((b) => b.textContent),
		).toEqual(["Reload"]);
	});

	it("announces the strip once, not every host after, and is silent once it goes", () => {
		vi.useFakeTimers();
		try {
			const { rerender } = renderStrip({ refusals: refusals("a.example") });
			const region = document.querySelector('[aria-live="polite"]');
			if (!region) throw new Error("no live region");
			const observer = new MutationObserver(() => {});
			observer.observe(region, {
				childList: true,
				characterData: true,
				subtree: true,
			});

			act(() => vi.advanceTimersByTime(200));
			rerender({ refusals: refusals("a.example", "b.example") });
			act(() => vi.advanceTimersByTime(200));
			rerender({ refusals: refusals("a.example", "b.example", "c.example") });
			act(() => vi.advanceTimersByTime(200));
			// Every time text is put in the region, a screen reader speaks it.
			const spoken = observer
				.takeRecords()
				.flatMap((record) =>
					record.type === "characterData"
						? [record.target.textContent]
						: [...record.addedNodes].map((node) => node.textContent),
				)
				.filter(Boolean);
			observer.disconnect();
			expect(spoken).toEqual(["Some of this page wasn't loaded."]);

			rerender({ refusals: refusals() });
			expect(region).toHaveTextContent("");
		} finally {
			vi.useRealTimers();
		}
	});
});
