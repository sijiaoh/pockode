import { useOutsideClick } from "@pockode/shared";
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useOutsideClick lives in packages/shared, which has no test runner of its
// own; web is where it is consumed, so it is verified from here.

// Deliberately an inline callback, which is what the real call sites pass: a
// fresh closure every render.
function Overlay({
	onOutside,
	claims,
}: {
	onOutside: () => void;
	claims?: boolean;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	useOutsideClick(true, (target, event) => {
		if (panelRef.current && !panelRef.current.contains(target)) {
			if (claims) event.stopPropagation();
			onOutside();
		}
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

	// The other half of "one gesture, one panel": the answer panel reads a press
	// on the dimmed transcript as its own dismissal, from `window`, so a
	// dropdown dismissing on the same press has to take it off the path. The
	// hook cannot do that on the caller's behalf — only the caller knows the
	// click was a dismissal at all — so it hands over the event.
	it("lets the caller claim the click it dismisses on", () => {
		const onOutside = vi.fn();
		const onWindow = vi.fn();
		window.addEventListener("click", onWindow);
		render(<Overlay onOutside={onOutside} claims />);
		settle();

		act(() => screen.getByText("outside").click());
		window.removeEventListener("click", onWindow);

		expect(onOutside).toHaveBeenCalled();
		expect(onWindow).not.toHaveBeenCalled();
	});

	// And only the press it claims: a click it lets through is not its to take.
	it("leaves a click it ignores on its way", () => {
		const onOutside = vi.fn();
		const onWindow = vi.fn();
		window.addEventListener("click", onWindow);
		render(<Overlay onOutside={onOutside} claims />);
		settle();

		act(() => screen.getByText("inside").click());
		window.removeEventListener("click", onWindow);

		expect(onOutside).not.toHaveBeenCalled();
		expect(onWindow).toHaveBeenCalled();
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
