import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFileDropGuard } from "./useFileDropGuard";

function Guarded() {
	useFileDropGuard();
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a drop zone has no role that carries drag semantics, and keyboard users reach uploading through the upload button instead
		<div
			data-testid="zone"
			onDragOver={(event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
		>
			a drop zone
		</div>
	);
}

function dispatch(
	target: EventTarget,
	type: string,
	types: string[],
): { event: Event; dataTransfer: { dropEffect: string } } {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const dataTransfer = { types, dropEffect: "none" };
	// jsdom has no `DataTransfer`; this is the shape the handlers read.
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	target.dispatchEvent(event);
	return { event, dataTransfer };
}

describe("useFileDropGuard", () => {
	it("stops a file dropped outside a drop zone from replacing the app", () => {
		render(<Guarded />);

		const over = dispatch(document.body, "dragover", ["Files"]);
		const drop = dispatch(document.body, "drop", ["Files"]);

		// Left alone, the browser navigates to the dropped file and the session is
		// gone — which is what happens every time someone misses the panel.
		expect(over.event.defaultPrevented).toBe(true);
		expect(drop.event.defaultPrevented).toBe(true);
		expect(over.dataTransfer.dropEffect).toBe("none");
	});

	it("lets a real drop zone claim the drag anyway", () => {
		render(<Guarded />);

		const { dataTransfer } = dispatch(screen.getByTestId("zone"), "dragover", [
			"Files",
		]);

		// The guard runs in the capture phase, so the zone's own handler — which
		// runs later, on the way back up — still has the last word on the cursor.
		expect(dataTransfer.dropEffect).toBe("copy");
	});

	it("leaves drags that carry no files alone", () => {
		render(<Guarded />);

		// Dragging selected text into an input is not this hook's business.
		const { event } = dispatch(document.body, "dragover", ["text/plain"]);

		expect(event.defaultPrevented).toBe(false);
	});
});
