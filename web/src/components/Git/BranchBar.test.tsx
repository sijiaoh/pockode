import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchMergeHandoff } from "../../hooks/useBranchMergeHandoff";
import { gitCheckoutActions } from "../../lib/gitCheckoutStore";
import { gitSyncActions } from "../../lib/gitSyncStore";
import { makeBranches, makeHead, makeSync } from "../../test/gitFixtures";
import type { GitBranches, GitStatus } from "../../types/git";
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

let status: GitStatus | undefined;
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));

let branches: GitBranches | undefined;
vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches, isLoading: false, error: null }),
}));

const dismissHandoffError = vi.fn();
let mergeHandoff: Pick<BranchMergeHandoff, "error" | "dismissError">;

function bar(branchFailureSurface = false) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<BranchBar
				branchFailureSurface={branchFailureSurface}
				mergeHandoff={mergeHandoff}
			/>
		</QueryClientProvider>
	);
}

function renderBar(branchFailureSurface = false) {
	return render(bar(branchFailureSurface));
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

beforeEach(() => {
	status = undefined;
	dismissHandoffError.mockReset();
	mergeHandoff = { error: null, dismissError: dismissHandoffError };
	gitSyncActions.reset();
	gitCheckoutActions.reset();
});

describe("BranchBar sync feedback", () => {
	beforeEach(() => {
		branches = makeBranches({ sync: makeSync({ behind: 2 }) });
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
		rerender(bar());

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

	// Nobody asked for the automatic fetch, so its failure interrupts nobody:
	// it waits on the chip until the user opens the sheet to see why.
	it("marks a failed automatic fetch on the chip and explains it in the sheet", async () => {
		const user = userEvent.setup();
		await gitSyncActions.startAutoFetch("", () =>
			Promise.reject(new Error("fatal: unable to access 'origin'")),
		);
		renderBar();

		expect(screen.queryByRole("alert")).toBeNull();
		await user.click(
			screen.getByRole("button", {
				name: "Sync with remote, 2 to pull, automatic fetch failed",
			}),
		);

		const reason = screen.getByRole("alert");
		expect(reason).toHaveTextContent("Automatic fetch failed.");
		expect(reason).toHaveTextContent("fatal: unable to access 'origin'");

		// Seeing it does not make the counts fresh.
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.getByRole("button", { name: /automatic fetch failed/ }),
		).toBeInTheDocument();
	});
});

/** A switch that has already failed, as the store holds it afterwards. */
async function failedSwitch() {
	await gitCheckoutActions.start("", "topic", () =>
		Promise.reject(new Error("error: would be overwritten by checkout")),
	);
}

describe("BranchBar switch feedback", () => {
	beforeEach(() => {
		branches = makeBranches();
	});

	// The switch was walked away from mid-run; the user is somewhere else in the
	// workspace, believing it happened unless something says otherwise.
	it("reports a switch that failed off the Branches segment under the bar", async () => {
		const user = userEvent.setup();
		await failedSwitch();
		renderBar();

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not switch to topic. Commit or discard these changes first.",
		);

		await user.click(screen.getByRole("button", { name: "Dismiss error" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	// One failure in one place: on the segment, its pinned area holds it.
	it("leaves the failure to the Branches segment while it is on screen", async () => {
		await failedSwitch();
		const { rerender } = renderBar(true);

		expect(screen.queryByRole("alert")).toBeNull();

		rerender(bar(false));
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not switch to topic.",
		);
	});

	// The pinned area is part of the list; with no list to draw, the segment
	// cannot hold the failure, so the bar keeps it.
	it("keeps the failure under the bar when the Branches segment has no list", async () => {
		await failedSwitch();
		branches = undefined;
		renderBar(true);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not switch to topic.",
		);
	});

	// Two sources, two banners: neither may hide the other's failure.
	it("shows a sync failure and a switch failure side by side", async () => {
		await failedSwitch();
		await gitSyncActions.start(
			"",
			"pull",
			() => Promise.reject(new Error("fatal: could not read from remote")),
			() => "Pull failed.",
		);
		renderBar();

		const banners = screen.getAllByRole("alert");
		expect(banners).toHaveLength(2);
		expect(banners[0]).toHaveTextContent("Pull failed.");
		expect(banners[1]).toHaveTextContent("Could not switch to topic.");
	});

	// A delete's confirm closes when the user leaves; a failure that settles
	// after that follows the switch's rule, beside it rather than in its place.
	it("reports a delete that failed off the Branches segment, beside a switch's", async () => {
		await failedSwitch();
		await gitCheckoutActions.startDelete("", "spike", () =>
			Promise.reject(new Error("error: cannot lock ref")),
		);
		const { rerender } = renderBar(true);
		expect(screen.queryByRole("alert")).toBeNull();

		rerender(bar(false));
		const banners = screen.getAllByRole("alert");
		expect(banners).toHaveLength(2);
		expect(banners[1]).toHaveTextContent("Could not delete spike.");
	});

	// The user can move to another segment while the merge's new chat is
	// being created; its failure then has nowhere else to go.
	it("reports a merge handoff that failed off the Branches segment", async () => {
		const user = userEvent.setup();
		mergeHandoff = {
			error: { summary: "Couldn't start a new chat", detail: null },
			dismissError: dismissHandoffError,
		};
		const { rerender } = renderBar(true);
		expect(screen.queryByRole("alert")).toBeNull();

		rerender(bar(false));
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Couldn't start a new chat",
		);
		await user.click(screen.getByRole("button", { name: "Dismiss error" }));
		expect(dismissHandoffError).toHaveBeenCalled();
	});

	// A switch is about the worktree it was started in.
	it("keeps another worktree's failed switch out of this one", async () => {
		await gitCheckoutActions.start("feature", "topic", () =>
			Promise.reject(new Error("boom")),
		);
		renderBar();

		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("BranchBar during a rebase", () => {
	// A rebase detaches HEAD: `detached @ hash` is true, and useless.
	it("names the branch being rebased instead of the detached HEAD", () => {
		branches = makeBranches({
			head: makeHead({ branch: "", detached: true, hash: "4be1f20" }),
		});
		status = {
			staged: [],
			unstaged: [],
			operation: { kind: "rebase", branch: "feature/git-ui" },
		};
		renderBar();

		expect(screen.getByTitle("feature/git-ui")).toBeInTheDocument();
		expect(screen.getByText("· rebasing")).toBeInTheDocument();
		expect(screen.queryByText(/detached/)).toBeNull();
	});
});

describe("BranchBar's branch name", () => {
	// The segment control under the bar is the way to Branches; the name only
	// says where the user is.
	it("is plain text, leaving the sync chip the bar's only control", () => {
		branches = makeBranches({
			head: makeHead({ branch: "feature/x" }),
			sync: makeSync({ behind: 2 }),
		});
		renderBar();

		expect(screen.getByText("Current branch:")).toBeInTheDocument();
		expect(screen.getByTitle("feature/x")).toBeInTheDocument();
		expect(screen.getAllByRole("button")).toEqual([
			screen.getByRole("button", { name: /Sync with remote/ }),
		]);
	});
});
