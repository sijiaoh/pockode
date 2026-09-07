import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StagedSubmodule } from "../../types/git";
import CommitSheet, { type LastCommit } from "./CommitSheet";

const LAST_COMMIT: LastCommit = {
	message: "Show what the permission mode does\n\nWith a body.",
	pushedTo: null,
};

function renderSheet(
	props: {
		stagedCount?: number;
		submodules?: StagedSubmodule[];
		lastCommit?: LastCommit | null;
		amendInitially?: boolean;
		onCommit?: (message: string, amend: boolean) => Promise<void>;
	} = {},
) {
	const onCommit = props.onCommit ?? vi.fn().mockResolvedValue(undefined);
	const onClose = vi.fn();

	render(
		<CommitSheet
			stagedCount={props.stagedCount ?? 2}
			submodules={props.submodules ?? []}
			lastCommit={props.lastCommit === undefined ? null : props.lastCommit}
			amendInitially={props.amendInitially ?? false}
			onClose={onClose}
			onCommit={onCommit}
		/>,
	);

	return { onCommit, onClose };
}

const message = () => screen.getByRole("textbox", { name: "Commit message" });
const commitButton = () => screen.getByRole("button", { name: "Commit" });
const amendToggle = () =>
	screen.getByRole("checkbox", { name: "Amend last commit" });

describe("CommitSheet", () => {
	it("commits the typed message", async () => {
		const user = userEvent.setup();
		const { onCommit } = renderSheet({ stagedCount: 2 });

		expect(screen.getByText("2 files staged")).toBeInTheDocument();
		expect(commitButton()).toBeDisabled();

		await user.type(message(), "Fix it");
		await user.click(commitButton());

		expect(onCommit).toHaveBeenCalledWith("Fix it", false);
	});

	// Staging happens in the submodule's own index, which a root-repository
	// commit does not reach — so the sheet has to say which files it excludes.
	it("names staged submodule files it does not include", () => {
		renderSheet({
			stagedCount: 2,
			submodules: [{ path: "vendor/sdk", count: 2 }],
		});

		expect(
			screen.getByText("2 staged files in vendor/sdk are not included"),
		).toBeInTheDocument();
	});

	it("has no amend toggle before the first commit", () => {
		renderSheet({ lastCommit: null });

		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
	});

	it("prefills the previous message when amend is turned on", async () => {
		const user = userEvent.setup();
		const { onCommit } = renderSheet({ lastCommit: LAST_COMMIT });

		await user.click(amendToggle());

		expect(message()).toHaveValue(LAST_COMMIT.message);
		expect(
			screen.getByText("Replaces “Show what the permission mode does”"),
		).toBeInTheDocument();

		await user.click(commitButton());
		expect(onCommit).toHaveBeenCalledWith(LAST_COMMIT.message, true);
	});

	// Toggling is a way to change your mind, not a way to lose what you wrote.
	it("never overwrites a message the user typed", async () => {
		const user = userEvent.setup();
		renderSheet({ lastCommit: LAST_COMMIT });

		await user.type(message(), "Mine");
		await user.click(amendToggle());

		expect(message()).toHaveValue("Mine");
	});

	// The untouched prefill is not something the user wrote, so turning amend
	// back off must not leave it behind as the next commit's message.
	it("takes the untouched prefill back when amend is turned off", async () => {
		const user = userEvent.setup();
		renderSheet({ lastCommit: LAST_COMMIT });

		await user.click(amendToggle());
		await user.click(amendToggle());

		expect(message()).toHaveValue("");
	});

	it("opens ready to amend when there is nothing staged", () => {
		renderSheet({
			stagedCount: 0,
			lastCommit: LAST_COMMIT,
			amendInitially: true,
		});

		expect(amendToggle()).toBeChecked();
		expect(message()).toHaveValue(LAST_COMMIT.message);
		expect(
			screen.getByText("Nothing staged — only the message changes"),
		).toBeInTheDocument();
	});

	// The sheet opens in this state whenever nothing is staged, so switching
	// amend off leaves a commit git would certainly refuse.
	it("cannot commit with nothing staged and amend switched off", async () => {
		const user = userEvent.setup();
		renderSheet({
			stagedCount: 0,
			lastCommit: LAST_COMMIT,
			amendInitially: true,
		});

		// Typed first, so the message survives the toggle and the button can only
		// be disabled because there is nothing to put in a commit.
		await user.type(message(), "!");
		await user.click(amendToggle());

		expect(message()).not.toHaveValue("");
		expect(
			screen.getByText(
				"Nothing staged — stage a file, or amend the last commit",
			),
		).toBeInTheDocument();
		expect(commitButton()).toBeDisabled();
	});

	// Rewriting a commit the upstream already has is the one consequence the
	// user cannot undo by editing the sheet.
	it("warns that amending a pushed commit forces the next push", async () => {
		const user = userEvent.setup();
		renderSheet({
			lastCommit: { ...LAST_COMMIT, pushedTo: "origin/main" },
		});

		expect(screen.queryByText(/force push/)).not.toBeInTheDocument();

		await user.click(amendToggle());

		expect(
			screen.getByText(
				"This commit is already on origin/main — pushing afterwards needs a force push.",
			),
		).toBeInTheDocument();
	});

	// A rejected hook or a missing git identity is fixed and retried from here,
	// which only works if the sheet keeps what was typed.
	it("keeps the message and shows git's own words when the commit fails", async () => {
		const user = userEvent.setup();
		const onCommit = vi
			.fn()
			.mockRejectedValue(new Error("commit-msg hook: subject too long"));
		const { onClose } = renderSheet({ onCommit });

		await user.type(message(), "Wip");
		await user.click(commitButton());

		await waitFor(() => {
			expect(
				screen.getByText("commit-msg hook: subject too long"),
			).toBeInTheDocument();
		});
		expect(screen.getByText("Commit failed.")).toBeInTheDocument();
		expect(message()).toHaveValue("Wip");
		expect(onClose).not.toHaveBeenCalled();
	});

	// git tells the user to run git config, which is exactly what they cannot do
	// from a phone.
	it("points at the agent when git has no identity configured", async () => {
		const user = userEvent.setup();
		const onCommit = vi
			.fn()
			.mockRejectedValue(
				new Error(
					'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"',
				),
			);
		renderSheet({ onCommit });

		await user.type(message(), "Wip");
		await user.click(commitButton());

		await waitFor(() => {
			expect(screen.getByText(/no git identity/)).toBeInTheDocument();
		});
	});
});
