import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitSyncActions } from "../../lib/gitSyncStore";
import { makeHead, makeSync } from "../../test/gitFixtures";
import type { GitBranches } from "../../types/git";
import BranchBar from "./BranchBar";

const pull = vi.fn();
const wsState = {
	actions: { fetchRemote: vi.fn(), pull, push: vi.fn() },
};
vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
}));

let branches: GitBranches | undefined;
vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error: null }),
	useGitBranchActions: () => ({
		checkoutMutation: { mutateAsync: vi.fn() },
		createMutation: { mutateAsync: vi.fn() },
	}),
}));

function renderBar() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<BranchBar />
		</QueryClientProvider>,
	);
}

/** A pull that has already failed, as the store holds it afterwards. */
async function failedPull() {
	await gitSyncActions.start(
		"",
		"pull",
		() => Promise.reject(new Error("fatal: could not read from remote")),
		() => "Pull failed.",
	);
}

describe("BranchBar sync feedback", () => {
	beforeEach(() => {
		gitSyncActions.reset();
		branches = {
			head: makeHead(),
			local: [],
			remote_only: [],
			sync: makeSync({ behind: 2 }),
		};
		pull.mockReset();
	});

	// The sheet the pull was started from may be long gone by the time it fails,
	// and a failure nobody is told about is the one outcome the panel must not
	// have.
	it("reports a failure whose sheet has been closed under the branch bar", async () => {
		const user = userEvent.setup();
		await failedPull();
		renderBar();

		const banner = screen.getByRole("alert");
		expect(banner).toHaveTextContent("Pull failed.");

		await user.click(screen.getByRole("button", { name: "Dismiss error" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	// One outcome, shown wherever the user is: the sheet already says it, so the
	// banner would be saying it twice.
	it("hands the same failure back to the sheet when it is reopened", async () => {
		const user = userEvent.setup();
		await failedPull();
		renderBar();

		await user.click(screen.getByRole("button", { name: /Sync with remote/ }));

		expect(screen.getByRole("alert")).toHaveTextContent(
			"fatal: could not read from remote",
		);
		expect(screen.queryByRole("button", { name: "Dismiss error" })).toBeNull();

		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Pull failed.");
	});

	// The sheet only holds the message while it is really on screen. Once
	// git.branches stops answering there is no sheet to render, and a failure
	// suppressed by a sheet that is not there is a silent failure.
	it("takes a failure back from a sheet that has stopped rendering", async () => {
		const user = userEvent.setup();
		await failedPull();
		const { rerender } = renderBar();

		await user.click(screen.getByRole("button", { name: /Sync with remote/ }));
		expect(screen.queryByRole("button", { name: "Dismiss error" })).toBeNull();

		branches = undefined;
		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<BranchBar />
			</QueryClientProvider>,
		);

		expect(screen.getByText("Branch unavailable")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("Pull failed.");
	});

	// The chip is where the sync was started from, so it is where a run that
	// outlived its sheet reports that it is still going.
	it("shows the running operation on the chip", async () => {
		pull.mockReturnValue(new Promise(() => {}));
		gitSyncActions.start(
			"",
			"pull",
			() => pull(),
			() => "Pull failed.",
		);
		renderBar();

		expect(
			screen.getByRole("button", { name: "Sync with remote, pulling…" }),
		).toBeInTheDocument();
	});
});
