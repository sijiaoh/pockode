import {
	ConfirmDialog,
	Sheet,
	useCoverPage,
	useIsDrawnOver,
	useIsPageCovered,
} from "@pockode/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

// Lives here beside `Sheet.test.tsx` for the reason given there: shared has no
// test entry point of its own.

function Probe() {
	return <output>{useIsPageCovered() ? "covered" : "clear"}</output>;
}

function probe() {
	return screen.getByRole("status").textContent;
}

function Panel({ open }: { open: boolean }) {
	useCoverPage(open, { onBack: () => {} });
	return null;
}

describe("useIsPageCovered", () => {
	beforeEach(() => {
		document.body.style.overflow = "";
	});

	it("follows a panel's open flag without locking the body", () => {
		const { rerender } = render(
			<>
				<Probe />
				<Panel open={false} />
			</>,
		);
		expect(probe()).toBe("clear");

		rerender(
			<>
				<Probe />
				<Panel open />
			</>,
		);
		expect(probe()).toBe("covered");
		expect(document.body.style.overflow).toBe("");

		rerender(
			<>
				<Probe />
				<Panel open={false} />
			</>,
		);
		expect(probe()).toBe("clear");
	});

	it("stays covered until the last of several layers is gone", () => {
		const layers = (a: boolean, b: boolean) => (
			<>
				<Probe />
				<Panel open={a} />
				<Panel open={b} />
			</>
		);
		const { rerender } = render(layers(true, true));

		rerender(layers(false, true));
		expect(probe()).toBe("covered");

		rerender(layers(false, false));
		expect(probe()).toBe("clear");
	});

	it("clears when a panel and a sheet unmount in the same commit", () => {
		const { rerender } = render(
			<>
				<Probe />
				<Panel open />
				<Sheet title="Sheet" onClose={() => {}}>
					<ConfirmDialog
						title="Sure?"
						message="Really."
						onConfirm={() => {}}
						onCancel={() => {}}
					/>
				</Sheet>
			</>,
		);
		expect(probe()).toBe("covered");
		expect(document.body.style.overflow).toBe("hidden");

		rerender(<Probe />);

		expect(probe()).toBe("clear");
		expect(document.body.style.overflow).toBe("");
	});
});

function DrawnOverProbe() {
	return <output>{useIsDrawnOver() ? "drawn over" : "clear"}</output>;
}

describe("useIsDrawnOver", () => {
	it("counts any layer outside a sheet", () => {
		const { rerender } = render(
			<>
				<DrawnOverProbe />
				<Panel open={false} />
			</>,
		);
		expect(probe()).toBe("clear");
		rerender(
			<>
				<DrawnOverProbe />
				<Panel open />
			</>,
		);
		expect(probe()).toBe("drawn over");
	});

	it("does not count the sheet it is drawn in, only a layer over it", () => {
		const { rerender } = render(
			<Sheet title="Viewer" onClose={() => {}}>
				<DrawnOverProbe />
				<Panel open={false} />
			</Sheet>,
		);
		expect(probe()).toBe("clear");
		rerender(
			<Sheet title="Viewer" onClose={() => {}}>
				<DrawnOverProbe />
				<Panel open />
			</Sheet>,
		);
		expect(probe()).toBe("drawn over");
	});

	// Effects run child first: the panel registers before the sheet it is in.
	it("counts a layer opened inside its sheet as the sheet opens", () => {
		render(
			<Sheet title="Viewer" onClose={() => {}}>
				<DrawnOverProbe />
				<Panel open />
			</Sheet>,
		);
		expect(probe()).toBe("drawn over");
	});

	// A panel left up under a sheet opened over it is not over the sheet.
	it("does not count a layer already up when its sheet opened", () => {
		const { rerender } = render(<Panel open />);
		rerender(
			<>
				<Panel open />
				<Sheet title="Viewer" onClose={() => {}}>
					<DrawnOverProbe />
				</Sheet>
			</>,
		);
		expect(probe()).toBe("clear");
	});
});
