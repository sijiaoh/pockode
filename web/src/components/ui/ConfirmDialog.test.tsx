import { ConfirmDialog, type ConfirmDialogProps } from "@pockode/shared";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Lives here beside `Sheet.test.tsx` for the reason given there: shared has no
// test entry point of its own.

function deferred() {
	let resolve!: () => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function renderDialog(onConfirm: ConfirmDialogProps["onConfirm"]) {
	const onCancel = vi.fn();
	// Callers pass `onCancel` inline, so each of their renders hands over a new one.
	const dialog = () => (
		<ConfirmDialog
			title="Delete?"
			message="Really."
			confirmLabel="Delete"
			onConfirm={onConfirm}
			onCancel={() => onCancel()}
		/>
	);
	const { rerender } = render(dialog());
	return {
		onCancel,
		rerenderAsCaller: () => rerender(dialog()),
		confirmButton: () => screen.getByText("Delete").closest("button"),
	};
}

describe("ConfirmDialog", () => {
	it("starts the action once however often it is confirmed while running", async () => {
		const user = userEvent.setup();
		const action = deferred();
		const onConfirm = vi.fn(() => action.promise);
		const { confirmButton } = renderDialog(onConfirm);

		await user.click(confirmButton() as HTMLElement);
		await user.click(confirmButton() as HTMLElement);
		await user.keyboard("{Enter}");

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(confirmButton()).toHaveAttribute("aria-busy", "true");

		await act(async () => action.resolve());

		expect(confirmButton()).not.toHaveAttribute("aria-busy");
		await user.click(confirmButton() as HTMLElement);
		expect(onConfirm).toHaveBeenCalledTimes(2);
	});

	it("refuses cancel, Escape and the backdrop while the action runs", async () => {
		const user = userEvent.setup();
		const action = deferred();
		const { onCancel, confirmButton } = renderDialog(() => action.promise);

		await user.click(confirmButton() as HTMLElement);
		await user.click(screen.getByText("Cancel"));
		await user.keyboard("{Escape}");
		await user.click(screen.getByRole("dialog").firstElementChild as Element);
		expect(onCancel).not.toHaveBeenCalled();

		await act(async () => action.resolve());

		await user.keyboard("{Escape}");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("shows a failed action and can be confirmed again", async () => {
		const user = userEvent.setup();
		const action = deferred();
		const onConfirm = vi
			.fn()
			.mockReturnValueOnce(action.promise)
			.mockReturnValue(deferred().promise);
		const { confirmButton, rerenderAsCaller } = renderDialog(onConfirm);

		await user.click(confirmButton() as HTMLElement);
		rerenderAsCaller();
		await act(async () => action.reject(new Error("Not found")));

		expect(screen.getByRole("alert")).toHaveTextContent("Not found");
		expect(confirmButton()).toHaveFocus();
		await user.click(confirmButton() as HTMLElement);
		expect(onConfirm).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
