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
		render(<CommitBar />);

		const button = screen.getByRole("button", { name: "Commit (2)" });
		expect(button).toBeEnabled();

		await user.click(button);
		expect(screen.getByRole("dialog")).toHaveTextContent("committing");
	});

	// The user is on their way to committing, so the button stays put and says
	// what it is waiting for rather than appearing under their thumb mid-stage.
	it("waits, visibly, while nothing is staged yet", () => {
		status = { staged: [], unstaged: [file("a.ts")] };
		render(<CommitBar />);

		const button = screen.getByRole("button", { name: "Commit" });
		expect(button).toBeDisabled();
		expect(button).toHaveAccessibleDescription("Stage a file to commit");
		// The stage buttons it names are on screen right above the bar; the line
		// would only repeat them, so it is not worth 20px of a 288px panel.
		expect(screen.getByText("Stage a file to commit")).toHaveClass("sr-only");
	});

	// Staged rows on screen with no working commit button, and nothing else on
	// the panel to account for it: a screen reader alone is not enough here.
	it("says on screen why a submodule's staged files cannot be committed", () => {
		status = {
			staged: [],
			unstaged: [],
			submodules: { "vendor/sdk": { staged: [file("sub.ts")], unstaged: [] } },
		};
		render(<CommitBar />);

		expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
		const hint = screen.getByText(/Only submodule files are staged/);
		expect(hint).not.toHaveClass("sr-only");
	});

	// A clean tree has nothing to commit and nothing about to be, and amend now
	// lives on the commit it amends.
	it("renders nothing on a clean tree", () => {
		status = { staged: [], unstaged: [] };
		render(<CommitBar />);

		expect(commitButton()).not.toBeInTheDocument();
	});

	// The sheet is a portal holding a half-written message; a background refresh
	// that finds the tree clean must take the bar away without taking that too.
	it("keeps an open sheet when the tree goes clean underneath it", async () => {
		const user = userEvent.setup();
		status = { staged: [file("a.ts")], unstaged: [] };
		const { rerender } = render(<CommitBar />);
		await user.click(screen.getByRole("button", { name: "Commit (1)" }));

		status = { staged: [], unstaged: [] };
		rerender(<CommitBar />);

		expect(commitButton()).not.toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("renders nothing while the status cannot be read", () => {
		render(<CommitBar />);

		expect(commitButton()).not.toBeInTheDocument();
	});
});
