import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodeForm } from "./NodeForm";

const PATH_NOT_EXIST = "invalid node: path does not exist";

function renderForm(onSubmit: (...args: never[]) => Promise<void>) {
	const onClose = vi.fn();
	render(<NodeForm isOpen onClose={onClose} onSubmit={onSubmit as never} />);
	return { onClose };
}

const typePath = async (
	user: ReturnType<typeof userEvent.setup>,
	value: string,
) => user.type(screen.getByLabelText(/Project Path/), value);

describe("NodeForm", () => {
	// The sheet grabs focus for itself on open, so landing in the path field is
	// something this form has to do *after* it — worth pinning, because getting
	// the order wrong leaves a phone with no keyboard and the sheet's own box
	// focused instead.
	it("opens with the path field focused", () => {
		renderForm(vi.fn());

		expect(screen.getByLabelText(/Project Path/)).toHaveFocus();
	});
});

describe("NodeForm: a directory that does not exist yet", () => {
	// The question used to be a dialog stacked on the open sheet. It is asked in
	// the form now, which is why the assertion is about the button's own label:
	// the answer is the press the user was already making.
	it("offers creation inline and retries with create_missing_dir", async () => {
		const user = userEvent.setup();
		const onSubmit = vi
			.fn()
			.mockRejectedValueOnce(new Error(PATH_NOT_EXIST))
			.mockResolvedValueOnce(undefined);
		const { onClose } = renderForm(onSubmit);

		await typePath(user, "~/projects/new-app");
		await user.click(screen.getByRole("button", { name: "Add Node" }));

		expect(await screen.findByRole("status")).toHaveTextContent(
			"~/projects/new-app doesn’t exist yet. It will be created.",
		);
		expect(onSubmit).toHaveBeenLastCalledWith(
			"~/projects/new-app",
			undefined,
			false,
		);

		await user.click(
			await screen.findByRole("button", { name: "Create & Add" }),
		);

		expect(onSubmit).toHaveBeenLastCalledWith(
			"~/projects/new-app",
			undefined,
			true,
		);
		expect(onClose).toHaveBeenCalled();
	});

	it("labels the retry Create & Save when editing", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn().mockRejectedValue(new Error(PATH_NOT_EXIST));
		render(
			<NodeForm
				isOpen
				onClose={vi.fn()}
				onSubmit={onSubmit}
				editingNode={{
					id: "n1",
					path: "~/projects/new-app",
					name: "new-app",
					created_at: "2026-09-16T10:00:00Z",
					updated_at: "2026-09-16T10:00:00Z",
				}}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(
			await screen.findByRole("button", { name: "Create & Save" }),
		).toBeInTheDocument();
	});

	// Correcting a typo has to be as cheap as accepting the offer: a stale
	// "it will be created" over a path the user has since rewritten would
	// promise to create the wrong directory.
	it("withdraws the offer when the path is edited", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn().mockRejectedValue(new Error(PATH_NOT_EXIST));
		renderForm(onSubmit);

		await typePath(user, "~/projects/new-app");
		await user.click(screen.getByRole("button", { name: "Add Node" }));
		await screen.findByRole("status");

		await typePath(user, "s");

		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Add Node" }),
		).toBeInTheDocument();
	});

	// Creating is not what would fix any of the other path errors, so offering
	// it would be an offer to do nothing.
	it("shows other path errors as errors, with no offer to create", async () => {
		const user = userEvent.setup();
		const onSubmit = vi
			.fn()
			.mockRejectedValue(new Error("invalid node: path is not a directory"));
		renderForm(onSubmit);

		await typePath(user, "~/projects/notes.txt");
		await user.click(screen.getByRole("button", { name: "Add Node" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"path is not a directory",
		);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	// The backend's own message is the one that locates the problem; a form
	// that answered "could not create" with "it will be created" would loop.
	it("reports a failed creation instead of offering again", async () => {
		const user = userEvent.setup();
		const onSubmit = vi
			.fn()
			.mockRejectedValueOnce(new Error(PATH_NOT_EXIST))
			.mockRejectedValueOnce(
				new Error(
					"invalid node: could not create directory: permission denied",
				),
			);
		renderForm(onSubmit);

		await typePath(user, "/etc/new-app");
		await user.click(screen.getByRole("button", { name: "Add Node" }));
		await user.click(
			await screen.findByRole("button", { name: "Create & Add" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"could not create directory: permission denied",
		);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
