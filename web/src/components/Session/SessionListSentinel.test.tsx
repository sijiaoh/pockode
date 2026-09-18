import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionListSentinel from "./SessionListSentinel";

/**
 * The observers the component opened, so a case can put the sentinel in view
 * the way a scroll would. The global stub in `test/setup.ts` never fires.
 */
let observers: { fire: () => void; disconnected: boolean }[] = [];

const realIntersectionObserver = globalThis.IntersectionObserver;

beforeEach(() => {
	observers = [];
	globalThis.IntersectionObserver = class {
		private entry: { fire: () => void; disconnected: boolean };
		constructor(callback: IntersectionObserverCallback) {
			this.entry = {
				fire: () =>
					callback(
						[{ isIntersecting: true } as IntersectionObserverEntry],
						this as unknown as IntersectionObserver,
					),
				disconnected: false,
			};
		}
		observe() {
			observers.push(this.entry);
		}
		unobserve() {}
		disconnect() {
			this.entry.disconnected = true;
		}
	} as unknown as typeof globalThis.IntersectionObserver;
});

afterEach(() => {
	globalThis.IntersectionObserver = realIntersectionObserver;
});

const props = {
	hasMore: true,
	isLoading: false,
	error: null as string | null,
	autoLoad: true,
	hasPaged: false,
	loadedCount: 30,
	onLoadMore: vi.fn(),
};

describe("SessionListSentinel", () => {
	// Infinite scroll with no manual control is the part of this pattern that is
	// routinely inaccessible, and it is also the only way on after a failure or a
	// page that did not fill the viewport.
	it("is a button, reachable and operable by keyboard alone", async () => {
		const onLoadMore = vi.fn();
		const user = userEvent.setup();
		render(<SessionListSentinel {...props} onLoadMore={onLoadMore} />);

		const button = screen.getByRole("button", {
			name: "Load earlier conversations",
		});
		await user.tab();
		expect(button).toHaveFocus();

		await user.keyboard("{Enter}");
		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it("asks for the next page when it comes into view", () => {
		const onLoadMore = vi.fn();
		render(<SessionListSentinel {...props} onLoadMore={onLoadMore} />);

		observers[0].fire();

		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	// An observer left armed over a sentinel that never moves retries in a tight
	// loop behind the user's back.
	it("shows Retry after a failure and does not retry by itself", async () => {
		const onLoadMore = vi.fn();
		const user = userEvent.setup();
		render(
			<SessionListSentinel
				{...props}
				error="Failed to load earlier conversations: boom"
				autoLoad={false}
				onLoadMore={onLoadMore}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("boom");
		expect(observers).toHaveLength(0);

		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	// On a list that fitted in one page, saying where it ends states the obvious.
	it("says where the list ends only once the user has paged", () => {
		const { rerender } = render(
			<SessionListSentinel {...props} hasMore={false} />,
		);
		expect(screen.queryByText("No earlier conversations")).toBeNull();

		rerender(<SessionListSentinel {...props} hasMore={false} hasPaged />);
		expect(screen.getByText("No earlier conversations")).toBeInTheDocument();
	});

	it("re-arms once a page has landed", () => {
		const onLoadMore = vi.fn();
		const { rerender } = render(
			<SessionListSentinel {...props} onLoadMore={onLoadMore} />,
		);

		observers[0].fire();
		expect(observers[0].disconnected).toBe(true);

		rerender(
			<SessionListSentinel
				{...props}
				loadedCount={60}
				onLoadMore={onLoadMore}
			/>,
		);
		observers[1].fire();

		expect(onLoadMore).toHaveBeenCalledTimes(2);
	});
});
