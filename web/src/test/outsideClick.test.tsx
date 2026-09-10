import { useOutsideClick } from "@pockode/shared";
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useOutsideClick lives in packages/shared, which has no test runner of its
// own; web is where it is consumed, so it is verified from here.

// Deliberately an inline callback, which is what the real call sites pass: a
// fresh closure every render.
function Overlay({ onOutside }: { onOutside: () => void }) {
	const panelRef = useRef<HTMLDivElement>(null);
	useOutsideClick(true, (target) => {
		if (panelRef.current && !panelRef.current.contains(target)) onOutside();
	});
	return (
		<>
			<div ref={panelRef}>
				<button type="button">inside</button>
			</div>
			<button type="button">outside</button>
		</>
	);
}

/** Lets the hook's deferred attach run. */
function settle() {
	act(() => {
		vi.advanceTimersByTime(0);
	});
}

describe("useOutsideClick", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("dismisses on a click outside", () => {
		const onOutside = vi.fn();
		render(<Overlay onOutside={onOutside} />);
		settle();

		act(() => screen.getByText("outside").click());

		expect(onOutside).toHaveBeenCalled();
	});

	it("ignores a click inside", () => {
		const onOutside = vi.fn();
		render(<Overlay onOutside={onOutside} />);
		settle();

		act(() => screen.getByText("inside").click());

		expect(onOutside).not.toHaveBeenCalled();
	});

	// The reason this hook is not built on `pointerdown`: a finger touching the
	// screen to scroll the page behind an overlay fires one immediately, before
	// the browser knows the gesture is not a tap, and the overlay the user was
	// reading would vanish under their thumb.
	it("survives a touch scroll starting outside", () => {
		const onOutside = vi.fn();
		render(<Overlay onOutside={onOutside} />);
		settle();

		act(() => {
			screen
				.getByText("outside")
				.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		});

		expect(onOutside).not.toHaveBeenCalled();
	});

	// The panel behind an overlay re-renders while it is open — once per
	// keystroke, for the command palette. The callback changes identity each
	// time, and a hook that depended on it would detach the listener and start
	// the deferred attach over, leaving a window with nothing listening.
	it("keeps listening while its host re-renders", () => {
		const onOutside = vi.fn();
		const { rerender } = render(<Overlay onOutside={onOutside} />);
		settle();

		rerender(<Overlay onOutside={onOutside} />);
		act(() => screen.getByText("outside").click());

		expect(onOutside).toHaveBeenCalled();
	});

	// The click that opens an overlay is still propagating when the effect runs,
	// and a listener added on `document` mid-flight still receives it — so the
	// overlay would close itself the moment it opened.
	it("ignores the click still in flight when it mounts", () => {
		const onOutside = vi.fn();
		render(<Overlay onOutside={onOutside} />);

		act(() => screen.getByText("outside").click());

		expect(onOutside).not.toHaveBeenCalled();
	});
});
