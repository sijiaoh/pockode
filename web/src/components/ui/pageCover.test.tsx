import {
	ConfirmDialog,
	Sheet,
	useCoverPage,
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
	useCoverPage(open);
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
