import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "../../types/git";
import CommitBar from "./CommitBar";

let status: GitStatus | undefined;

vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));
vi.mock("./GitCommitSheet", () => ({
	default: ({ amendInitially }: { amendInitially: boolean }) => (
		<div role="dialog">{amendInitially ? "amending" : "committing"}</div>
	),
}));

const file = (path: string) => ({ path, status: "M" as const });
const commitButton = () => screen.queryByRole("button", { name: /^Commit/ });

describe("CommitBar", () => {
	beforeEach(() => {
		status = undefined;
	});

	it("commits what is staged", async () => {
		const user = userEvent.setup();
		status = { staged: [file("a.ts"), file("b.ts")], unstaged: [] };
		render(<CommitBar discardUnchecked={null} />);

		const button = screen.getByRole("button", { name: "Commit 2 files" });
		expect(button).toBeEnabled();

		await user.click(button);
		expect(screen.getByRole("dialog")).toHaveTextContent("committing");
	});

	// The user is on their way to committing, so the button stays put and says
	// what it is waiting for rather than appearing under their thumb mid-stage.
	it("waits, visibly, while nothing is staged yet", () => {
		status = { staged: [], unstaged: [file("a.ts")] };
		render(<CommitBar discardUnchecked={null} />);

		const button = screen.getByRole("button", { name: "Commit" });
		expect(button).toBeDisabled();
		expect(button).toHaveAccessibleDescription("Check a file to commit");
		// The checkboxes it names are on screen right above the bar; the line
		// would only repeat them, so it is not worth 20px of a 288px panel.
		expect(screen.getByText("Check a file to commit")).toHaveClass("sr-only");
	});

	// Staged rows on screen with no working commit button, and nothing else on
	// the panel to account for it: a screen reader alone is not enough here.
	it("says on screen why a submodule's staged files cannot be committed", () => {
		status = {
			staged: [],
			unstaged: [],
			submodules: { "vendor/sdk": { staged: [file("sub.ts")], unstaged: [] } },
		};
		render(<CommitBar discardUnchecked={null} />);

		expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
		const hint = screen.getByText(/Only submodule files are staged/);
		expect(hint).not.toHaveClass("sr-only");
	});

	// A clean tree has nothing to commit and nothing about to be, and amend now
	// lives on the commit it amends.
	it("renders nothing on a clean tree", () => {
		status = { staged: [], unstaged: [] };
		render(<CommitBar discardUnchecked={null} />);

		expect(commitButton()).not.toBeInTheDocument();
	});

	// The sheet is a portal holding a half-written message; a background refresh
	// that finds the tree clean must take the bar away without taking that too.
	it("keeps an open sheet when the tree goes clean underneath it", async () => {
		const user = userEvent.setup();
		status = { staged: [file("a.ts")], unstaged: [] };
		const { rerender } = render(<CommitBar discardUnchecked={null} />);
		await user.click(screen.getByRole("button", { name: "Commit 1 file" }));

		status = { staged: [], unstaged: [] };
		rerender(<CommitBar discardUnchecked={null} />);

		expect(commitButton()).not.toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	// Left takes away and right keeps, as on the review's bar.
	it("puts the discard of what is unchecked before the commit button", async () => {
		const user = userEvent.setup();
		const onDiscard = vi.fn();
		status = { staged: [file("a.ts")], unstaged: [file("b.ts")] };
		render(<CommitBar discardUnchecked={{ onDiscard, busy: false }} />);

		const buttons = screen.getAllByRole("button");
		expect(buttons.map((b) => b.textContent)).toEqual([
			"Discard unchecked…",
			"Commit 1 file",
		]);

		await user.click(buttons[0]);
		expect(onDiscard).toHaveBeenCalled();
	});

	// A dimmed button says nothing, and a title never reaches a finger: the
	// press itself is what asks why.
	it("says why the discard is held when it is pressed mid-write", async () => {
		const user = userEvent.setup();
		const onDiscard = vi.fn();
		const reason = "Wait for the changes in progress to finish.";
		status = { staged: [file("a.ts")], unstaged: [file("b.ts")] };
		const { rerender } = render(
			<CommitBar discardUnchecked={{ onDiscard, busy: true }} />,
		);

		const discard = screen.getByRole("button", { name: "Discard unchecked…" });
		expect(discard).toHaveAttribute("aria-disabled", "true");
		expect(screen.queryByText(reason)).toBeNull();

		await user.click(discard);
		expect(onDiscard).not.toHaveBeenCalled();
		expect(discard).toHaveAccessibleDescription(reason);

		// Gone once the writes finish, and not back by itself on the next one.
		rerender(<CommitBar discardUnchecked={{ onDiscard, busy: false }} />);
		expect(screen.queryByText(reason)).toBeNull();
		rerender(<CommitBar discardUnchecked={{ onDiscard, busy: true }} />);
		expect(screen.queryByText(reason)).toBeNull();
	});

	it("renders nothing while the status cannot be read", () => {
		render(<CommitBar discardUnchecked={null} />);

		expect(commitButton()).not.toBeInTheDocument();
	});
});
