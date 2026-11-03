import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	DetailActionBottomBar,
	type DetailActions,
	type DetailActionsPlacement,
	PrimaryActionButton,
	ViewToolbar,
} from "./detailActions";

const actions: DetailActions = {
	leading: <button type="button">Delete</button>,
	primary: <PrimaryActionButton label="Save" onClick={vi.fn()} />,
};

// Both ends written, as a screen writes them: the placement decides which one
// draws the actions.
function renderDetail(
	actionsAt: DetailActionsPlacement,
	{ toggles }: { toggles?: boolean } = {},
) {
	return render(
		<>
			<ViewToolbar
				toggles={toggles && <button type="button">Wrap lines</button>}
				actions={actions}
				actionsAt={actionsAt}
			/>
			<main>body</main>
			<DetailActionBottomBar actions={actions} actionsAt={actionsAt} />
		</>,
	);
}

const precedesBody = (name: string) =>
	Boolean(
		screen
			.getByRole("button", { name })
			.compareDocumentPosition(screen.getByRole("main")) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	);

describe("detail actions", () => {
	it("draws the actions once, at the end the placement names", () => {
		const { unmount } = renderDetail("top");
		expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
		expect(precedesBody("Save")).toBe(true);
		unmount();

		renderDetail("bottom");
		expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
		expect(precedesBody("Save")).toBe(false);
	});

	it("keeps the toggles at the top while the actions are hidden", () => {
		renderDetail("hidden", { toggles: true });
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(precedesBody("Wrap lines")).toBe(true);
	});

	it("draws no toolbar when it would hold nothing", () => {
		const { container } = render(
			<ViewToolbar actions={actions} actionsAt="bottom" />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("keeps the leading action before the primary", () => {
		renderDetail("bottom");
		expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
			"Delete",
			"Save",
		]);
	});
});

describe("PrimaryActionButton", () => {
	it("says what it is doing while its action runs", () => {
		render(
			<PrimaryActionButton
				label="Save"
				pendingLabel="Saving…"
				disabled
				onClick={vi.fn()}
			/>,
		);
		const button = screen.getByRole("button", { name: "Saving…" });
		expect(button).toHaveAttribute("aria-busy", "true");
		expect(button).toBeDisabled();
	});
});
