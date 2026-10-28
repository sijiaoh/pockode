import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitBranchesQueryKey, gitStatusQueryKey } from "../../hooks/gitQueries";
import { gitOperationActions } from "../../lib/gitOperationStore";
import { makeHead, makeSync } from "../../test/gitFixtures";
import type { GitAbortResult, GitStatus } from "../../types/git";
import OperationBanner from "./OperationBanner";

const layout = vi.hoisted(() => ({ expanded: false }));
vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => layout.expanded,
}));

const abort = vi.fn<(kind: string) => Promise<GitAbortResult>>();
const wsState = { actions: { abort } };
vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
}));

const worktreeSwitch = vi.hoisted(() => ({ switching: false }));
vi.mock("../../hooks/useIsWorktreeSwitching", () => ({
	useIsWorktreeSwitching: () => worktreeSwitch.switching,
}));

// Has tests of its own (hooks/usePrefillComposer.test.tsx).
const prefill = vi.fn<(text: string) => Promise<void>>();
vi.mock("../../hooks/usePrefillComposer", () => ({
	usePrefillComposer: () => ({
		prefill,
		isPending: false,
		error: null,
		dismissError: () => {},
	}),
}));

const HASH = "9692fc9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7";

function rebaseStatus(conflicted: string[]): GitStatus {
	return {
		staged: [],
		unstaged: [],
		conflicted,
		operation: {
			kind: "rebase",
			commit: { hash: HASH, subject: "Add branch bar" },
			branch: "feature/git-ui",
			onto: { hash: HASH, subject: "Bump", ref: "main" },
			step: { current: 3, total: 7 },
		},
	};
}

let queryClient: QueryClient;

function renderBanner(
	status: GitStatus,
	{ compact = false, onSelectFile = vi.fn() } = {},
) {
	queryClient.setQueryData(gitStatusQueryKey, status);
	queryClient.setQueryData(gitBranchesQueryKey, {
		head: makeHead({ branch: "", detached: true }),
		local: [],
		remote_only: [],
		sync: makeSync(),
	});
	const view = render(
		<QueryClientProvider client={queryClient}>
			<OperationBanner compact={compact} onSelectFile={onSelectFile} />
		</QueryClientProvider>,
	);
	return { ...view, onSelectFile };
}

/** As a refetch lands: react-query tells its readers on the next tick. */
const setStatus = (status: GitStatus) =>
	act(async () => {
		queryClient.setQueryData(gitStatusQueryKey, status);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

const banner = () =>
	screen.getByRole("region", { name: "Rebase stopped on conflicts" });

beforeEach(() => {
	layout.expanded = false;
	worktreeSwitch.switching = false;
	queryClient = new QueryClient();
	gitOperationActions.reset();
	abort.mockReset();
	prefill.mockReset();
	prefill.mockResolvedValue();
});

describe("OperationBanner", () => {
	it("says nothing while no operation is in progress", () => {
		const { container } = renderBanner({ staged: [], unstaged: [] });
		expect(container).toBeEmptyDOMElement();
	});

	it("says what is in progress, between what, and how far along", () => {
		renderBanner(rebaseStatus(["b.ts"]));

		const region = banner();
		expect(region).toHaveTextContent(
			"Rebasing feature/git-ui onto main · 3 of 7",
		);
		expect(region).toHaveTextContent("At 9692fc9 Add branch bar");
		expect(region).toHaveTextContent(
			"Commits and branch switches are paused until the rebase is finished or aborted.",
		);
	});

	it("leaves the moment the status no longer has an operation", async () => {
		renderBanner(rebaseStatus(["b.ts"]));
		expect(banner()).toBeInTheDocument();

		await setStatus({ staged: [], unstaged: [] });
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("opens a conflicted file from its row", async () => {
		const user = userEvent.setup();
		const { onSelectFile } = renderBanner(rebaseStatus(["src/b.ts"]));

		await user.click(
			screen.getByRole("button", { name: "Review src/b.ts, conflicted" }),
		);
		expect(onSelectFile).toHaveBeenCalledWith("src/b.ts");
	});

	it("shows three files, then all of them on request", async () => {
		const user = userEvent.setup();
		renderBanner(rebaseStatus(["e", "d", "c", "b", "a"]));

		const rows = () => screen.getAllByRole("button", { name: /conflicted$/ });
		// The Changes list's order, not the status's.
		expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
			"Review a, conflicted",
			"Review b, conflicted",
			"Review c, conflicted",
		]);

		await user.click(screen.getByRole("button", { name: "Show all 5 files" }));
		expect(rows()).toHaveLength(5);
	});

	it("collapses to its title and actions, and remembers it for this operation only", async () => {
		const user = userEvent.setup();
		renderBanner(rebaseStatus(["b.ts"]));

		await user.click(screen.getByRole("button", { name: "Hide details" }));
		expect(banner()).not.toHaveTextContent("paused until");
		expect(
			screen.getByRole("button", { name: "Show details", expanded: false }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Resolve with agent/ }),
		).toBeInTheDocument();

		// The rebase's next step is still the same rebase.
		const next = rebaseStatus(["b.ts"]);
		if (next.operation) {
			next.operation.commit = { hash: "1".repeat(40), subject: "Next" };
			next.operation.step = { current: 4, total: 7 };
		}
		await setStatus(next);
		expect(banner()).not.toHaveTextContent("paused until");

		// Another operation opens again.
		await setStatus({ staged: [], unstaged: [] });
		await setStatus(rebaseStatus(["b.ts"]));
		expect(banner()).not.toHaveTextContent("paused until");
		await setStatus({
			staged: [],
			unstaged: [],
			conflicted: ["b.ts"],
			operation: { kind: "merge", commit: { hash: HASH, subject: "x" } },
		});
		expect(
			screen.getByRole("region", { name: "Merge stopped on conflicts" }),
		).toHaveTextContent("paused until");
	});

	it("says what is left when no conflict is", () => {
		renderBanner(rebaseStatus([]));

		const region = screen.getByRole("region", { name: "Rebase paused" });
		expect(region).toHaveTextContent(
			"No conflicts left. The rebase is paused at step 3 of 7.",
		);
		expect(
			within(region).getByRole("button", { name: "Finish with agent" }),
		).toBeInTheDocument();
	});

	it("hands the agent the operation and its conflicts", async () => {
		const user = userEvent.setup();
		renderBanner(rebaseStatus(["b.ts"]));

		await user.click(
			screen.getByRole("button", { name: /Resolve with agent/ }),
		);

		expect(prefill).toHaveBeenCalledTimes(1);
		const text = prefill.mock.calls[0][0];
		expect(text).toContain("a rebase of feature/git-ui onto main");
		expect(text).toContain("- b.ts");
	});

	it("draws one line on a layer", () => {
		renderBanner(rebaseStatus(["b.ts"]), { compact: true });

		expect(screen.queryByRole("region")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		expect(
			screen.getByText("Rebase stopped on conflicts").parentElement,
		).toHaveTextContent("Rebase stopped on conflicts· 3 of 7");
	});
});

describe("OperationBanner abort", () => {
	it("confirms, aborts the confirmed kind, and spins until the operation is gone", async () => {
		const user = userEvent.setup();
		abort.mockResolvedValue({ head_kept: false });
		renderBanner(rebaseStatus(["b.ts"]));

		await user.click(screen.getByRole("button", { name: "Abort" }));
		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveTextContent(
			"feature/git-ui goes back to how it was before the rebase. The 2 commits already replayed and any conflicts resolved so far are lost and cannot be recovered.",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Abort rebase" }),
		);

		expect(abort).toHaveBeenCalledWith("rebase");
		// No optimism: answered, but the status still shows the rebase.
		expect(
			await screen.findByRole("button", { name: "Aborting…" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /Resolve with agent/ }),
		).toBeDisabled();

		await setStatus({ staged: [], unstaged: [] });
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("does nothing when the dialog is cancelled", async () => {
		const user = userEvent.setup();
		renderBanner(rebaseStatus(["b.ts"]));

		await user.click(screen.getByRole("button", { name: "Abort" }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(abort).not.toHaveBeenCalled();
	});

	it("reports git's failure inside the banner", async () => {
		const user = userEvent.setup();
		abort.mockRejectedValue(
			new JSONRPCErrorException("error: cannot abort", -32603),
		);
		renderBanner(rebaseStatus(["b.ts"]));

		await user.click(screen.getByRole("button", { name: "Abort" }));
		await user.click(screen.getByRole("button", { name: "Abort rebase" }));

		const alert = await within(banner()).findByRole("alert");
		expect(alert).toHaveTextContent("Could not abort the rebase.");
		expect(screen.getByRole("button", { name: "Abort" })).toBeEnabled();
	});

	it("says so when another operation took its place, and nothing ran", async () => {
		const user = userEvent.setup();
		abort.mockRejectedValue(
			new JSONRPCErrorException("changed", -32005, { current: "merge" }),
		);
		renderBanner(rebaseStatus(["b.ts"]));

		await user.click(screen.getByRole("button", { name: "Abort" }));
		await user.click(screen.getByRole("button", { name: "Abort rebase" }));
		await screen.findByRole("button", { name: "Abort" });

		// The banner now shows the merge, and the failure stays with it.
		await setStatus({
			staged: [],
			unstaged: [],
			conflicted: ["b.ts"],
			operation: { kind: "merge", commit: { hash: HASH, subject: "x" } },
		});
		expect(
			within(
				screen.getByRole("region", { name: "Merge stopped on conflicts" }),
			).getByRole("alert"),
		).toHaveTextContent(
			"The rebase is no longer in progress — a merge is. Nothing was aborted.",
		);
	});

	it("says the branch was not moved back when git kept the commits", async () => {
		const user = userEvent.setup();
		abort.mockResolvedValue({ head_kept: true });
		renderBanner({
			staged: [],
			unstaged: [],
			operation: { kind: "cherry-pick" },
		});

		await user.click(screen.getByRole("button", { name: "Abort" }));
		await user.click(screen.getByRole("button", { name: "Abort cherry-pick" }));
		await screen.findByRole("button", { name: "Aborting…" });
		await setStatus({ staged: [], unstaged: [] });

		expect(screen.getByRole("status")).toHaveTextContent(
			"The cherry-pick has ended, but the commits made during it are still on HEAD. The branch was not moved back.",
		);
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	// git.changed can land before the reply: the rebase is gone, the request
	// not yet answered. The next rebase must not open as `Aborting…`.
	it("leaves nothing behind when the operation ends before the abort answers", async () => {
		const user = userEvent.setup();
		let answer: (result: GitAbortResult) => void = () => {};
		abort.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		renderBanner(rebaseStatus(["b.ts"]));

		await user.click(screen.getByRole("button", { name: "Abort" }));
		await user.click(screen.getByRole("button", { name: "Abort rebase" }));
		await setStatus({ staged: [], unstaged: [] });
		await act(async () => answer({ head_kept: false }));
		// The refetch the answer asks for: still nothing in progress.
		await setStatus({ staged: [], unstaged: [] });

		await setStatus(rebaseStatus(["b.ts"]));
		expect(screen.getByRole("button", { name: "Abort" })).toBeEnabled();
		expect(
			screen.getByRole("button", { name: /Resolve with agent/ }),
		).toBeEnabled();
	});

	it("keeps a failure through a worktree switch that has not landed", async () => {
		const user = userEvent.setup();
		abort.mockRejectedValue(new JSONRPCErrorException("error: x", -32603));
		const { rerender } = renderBanner(rebaseStatus(["b.ts"]));

		await user.click(screen.getByRole("button", { name: "Abort" }));
		await user.click(screen.getByRole("button", { name: "Abort rebase" }));
		await within(banner()).findByRole("alert");

		// Mid-switch the cache can hold another worktree's answer, with nothing
		// in progress; that says nothing about this rebase.
		worktreeSwitch.switching = true;
		rerender(
			<QueryClientProvider client={queryClient}>
				<OperationBanner compact={false} onSelectFile={vi.fn()} />
			</QueryClientProvider>,
		);
		await setStatus({ staged: [], unstaged: [] });
		worktreeSwitch.switching = false;
		queryClient.setQueryData(gitStatusQueryKey, rebaseStatus(["b.ts"]));
		rerender(
			<QueryClientProvider client={queryClient}>
				<OperationBanner compact={false} onSelectFile={vi.fn()} />
			</QueryClientProvider>,
		);

		expect(await within(banner()).findByRole("alert")).toHaveTextContent(
			"Could not abort the rebase.",
		);
	});

	it("drops the kept-commits notice once another operation starts", async () => {
		const user = userEvent.setup();
		abort.mockResolvedValue({ head_kept: true });
		renderBanner({
			staged: [],
			unstaged: [],
			operation: { kind: "cherry-pick" },
		});

		await user.click(screen.getByRole("button", { name: "Abort" }));
		await user.click(screen.getByRole("button", { name: "Abort cherry-pick" }));
		await screen.findByRole("button", { name: "Aborting…" });
		await setStatus({ staged: [], unstaged: [] });
		expect(screen.getByRole("status")).toBeInTheDocument();

		await setStatus(rebaseStatus(["b.ts"]));
		await setStatus({ staged: [], unstaged: [] });
		expect(screen.queryByRole("status")).toBeNull();
	});

	// The first status after the answer can already show the agent's next
	// rebase: that one has not been aborted.
	it("does not carry the spinner into a new operation of the same kind", async () => {
		const user = userEvent.setup();
		abort.mockResolvedValue({ head_kept: false });
		renderBanner(rebaseStatus(["b.ts"]));

		await user.click(screen.getByRole("button", { name: "Abort" }));
		await user.click(screen.getByRole("button", { name: "Abort rebase" }));
		await screen.findByRole("button", { name: "Aborting…" });

		const next = rebaseStatus(["c.ts"]);
		if (next.operation) {
			next.operation.onto = { hash: "1".repeat(40), subject: "Other" };
		}
		await setStatus(next);
		expect(screen.getByRole("button", { name: "Abort" })).toBeEnabled();
	});

	// Mid-switch the requests already go to the worktree being entered, while
	// the screen still shows the one being left.
	it("offers neither way out while the worktree is switching", () => {
		worktreeSwitch.switching = true;
		renderBanner(rebaseStatus(["b.ts"]));

		expect(screen.getByRole("button", { name: "Abort" })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /Resolve with agent/ }),
		).toBeDisabled();
	});
});
