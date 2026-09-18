import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import WorkPrimaryAction, { type WorkAction } from "./WorkPrimaryAction";

function renderButton(props: Partial<Parameters<typeof WorkPrimaryAction>[0]>) {
	const onActivate = vi.fn();
	render(
		<WorkPrimaryAction
			action="start"
			busy={false}
			failed={false}
			workTitle="Work"
			onActivate={onActivate}
			{...props}
		/>,
	);
	return { onActivate };
}

describe("WorkPrimaryAction", () => {
	// A glyph on every row, so the name it is announced under has to carry both
	// the verb and the work — a screen reader walking a list meets a column of
	// identical verbs otherwise.
	it.each([
		["start", "Start"],
		["stop", "Stop"],
		["restart", "Restart"],
		["reopen", "Reopen"],
	] as [WorkAction, string][])("announces %s as %s", (action, label) => {
		renderButton({ action });

		expect(
			screen.getByRole("button", { name: `${label} "Work"` }),
		).toBeInTheDocument();
	});

	it("asks the row to run the command", async () => {
		const user = userEvent.setup();
		const { onActivate } = renderButton({});

		await user.click(screen.getByRole("button", { name: 'Start "Work"' }));

		expect(onActivate).toHaveBeenCalled();
	});

	// The guard against a second session is the row's, but a button that still
	// invites the tap while one is in flight is a button that lies.
	it("cannot be pressed while the command is in flight", () => {
		renderButton({ busy: true });

		expect(screen.getByRole("button", { name: 'Start "Work"' })).toBeDisabled();
	});

	// The row writes the failure out below. The button keeps its verb — losing it
	// is losing which button it was, exactly when that matters most — and it has
	// no tooltip, which the platform's own pointer could never have opened.
	it("keeps saying what it does after a failure", () => {
		renderButton({ failed: true });

		const button = screen.getByRole("button", { name: 'Start "Work"' });
		expect(button).not.toHaveAttribute("title");
		expect(button.className).toContain("text-th-error");
	});
});
