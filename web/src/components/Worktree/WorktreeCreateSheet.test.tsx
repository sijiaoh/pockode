import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SetupHookSkip } from "../../types/message";
import WorktreeCreateSheet from "./WorktreeCreateSheet";

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

const skip: SetupHookSkip = {
	reason: "no bash.exe from Git for Windows found",
	hint: "delete worktree-setup.sh from the data directory",
};

function renderSheet(props: {
	onCreate: (
		name: string,
		branch: string,
		baseBranch?: string,
	) => Promise<SetupHookSkip | null>;
	setupHookSkip?: SetupHookSkip | null;
	onClose?: () => void;
}) {
	return render(
		<WorktreeCreateSheet
			onClose={props.onClose ?? vi.fn()}
			onCreate={props.onCreate}
			isCreating={false}
			setupHookSkip={props.setupHookSkip ?? null}
			isDesktop={true}
		/>,
	);
}

async function submitName(name: string) {
	const user = userEvent.setup();
	await user.type(screen.getByLabelText("Name"), name);
	await user.click(screen.getByRole("button", { name: "Create" }));
}

describe("WorktreeCreateSheet", () => {
	it("says the setup script runs when it can", () => {
		renderSheet({ onCreate: vi.fn() });
		expect(screen.getByText("Setup script runs after creation.")).toBeVisible();
	});

	it("warns before creating when the setup script cannot run", () => {
		renderSheet({ onCreate: vi.fn(), setupHookSkip: skip });
		expect(
			screen.getByText("Setup script will not run on the server."),
		).toBeVisible();
		expect(screen.getByText(skip.reason)).toBeVisible();
		expect(screen.getByText(skip.hint)).toBeVisible();
	});

	// The created worktree looks exactly like a fully prepared one, so the sheet
	// has to say what happened rather than just close.
	it("reports a skipped setup script after creating", async () => {
		const onClose = vi.fn();
		renderSheet({
			onCreate: vi.fn().mockResolvedValue(skip),
			setupHookSkip: skip,
			onClose,
		});

		await submitName("review");

		expect(
			screen.getByText(/was created, but its setup script did not run/),
		).toBeVisible();
		expect(screen.getByText(skip.reason)).toBeVisible();
		expect(onClose).not.toHaveBeenCalled();

		await userEvent.setup().click(screen.getByRole("button", { name: "Done" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("stays out of the way when the setup script ran", async () => {
		const onCreate = vi.fn().mockResolvedValue(null);
		renderSheet({ onCreate });

		await submitName("review");

		expect(onCreate).toHaveBeenCalledWith("review", "review", undefined);
		expect(
			screen.queryByText(/setup script did not run/),
		).not.toBeInTheDocument();
	});
});
