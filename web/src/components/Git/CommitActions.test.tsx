import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitBranchesQueryKey } from "../../hooks/gitQueries";
import { makeHead, makeSync } from "../../test/gitFixtures";
import type { GitBranchCreateParams, GitStatus } from "../../types/git";
import CommitActions, { type CommitMenuTarget } from "./CommitActions";

const createBranch = vi.fn<(params: GitBranchCreateParams) => Promise<void>>();
const wsState = { actions: { createBranch } };
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

// Has tests of its own (hooks/usePrefillComposer.test.tsx).
const prefill = vi.fn<(text: string) => Promise<void>>();
let handoffError: { summary: string; detail: string | null } | null;
vi.mock("../../hooks/usePrefillComposer", () => ({
	usePrefillComposer: () => ({
		prefill,
		isPending: false,
		error: handoffError,
		dismissError: () => {},
	}),
}));

vi.mock("./GitCommitSheet", () => ({
	default: ({
		amendInitially,
		onClose,
	}: {
		amendInitially: boolean;
		onClose: () => void;
	}) => (
		<div role="dialog" aria-label="Commit">
			{amendInitially ? "amending" : "committing"}
			<button type="button" onClick={onClose}>
				Close
			</button>
		</div>
	),
}));

const HASH = "abc1234def5678901234567890123456789012ab";
const HEAD_REFS = [
	{ name: "HEAD", type: "head" as const },
	{ name: "topic", type: "branch" as const, current: true },
];

let queryClient: QueryClient;

function target(extra: Partial<CommitMenuTarget["commit"]> = {}) {
	return {
		commit: { hash: HASH, subject: "Add lane layout", parents: [], ...extra },
	};
}

function renderMenu(menuFor: CommitMenuTarget | null) {
	const onClose = vi.fn();
	render(
		<QueryClientProvider client={queryClient}>
			<CommitActions target={menuFor} onClose={onClose} />
		</QueryClientProvider>,
	);
	return onClose;
}

const menu = () =>
	screen.getByRole("dialog", { name: "abc1234 Add lane layout" });

function rowNames() {
	return within(menu())
		.getAllByRole("button")
		.map((b) => b.textContent)
		.filter((name) => name !== "");
}

beforeEach(() => {
	queryClient = new QueryClient();
	queryClient.setQueryData(gitBranchesQueryKey, {
		head: makeHead({ branch: "feature/graph" }),
		local: [],
		remote_only: [],
		sync: makeSync(),
	});
	status = { staged: [], unstaged: [] };
	createBranch.mockReset();
	createBranch.mockResolvedValue();
	prefill.mockReset();
	prefill.mockResolvedValue();
	handoffError = null;
});

describe("CommitActions", () => {
	it("offers everything on HEAD", () => {
		renderMenu(target({ refs: HEAD_REFS }));

		expect(rowNames()).toEqual([
			"Copy hash",
			"Amend this commit",
			"Create branch here…",
			"Ask AI to revert",
		]);
	});

	it("leaves amend out on HEAD until the status is known", () => {
		status = undefined;
		renderMenu(target({ refs: HEAD_REFS }));
		expect(rowNames()).not.toContain("Amend this commit");
	});

	it("leaves amend out on any commit but HEAD", () => {
		renderMenu(target());
		expect(rowNames()).not.toContain("Amend this commit");
	});

	// git refuses amend mid-merge, and mid-rebase HEAD is not the branch's.
	it("leaves amend out on HEAD while an operation is in progress", () => {
		status = { staged: [], unstaged: [], operation: { kind: "merge" } };
		renderMenu(target({ refs: HEAD_REFS }));
		expect(rowNames()).not.toContain("Amend this commit");
	});

	it("hides revert only where HEAD is known not to reach the commit", () => {
		renderMenu({ ...target(), inHeadHistory: false });
		expect(rowNames()).not.toContain("Ask AI to revert");
	});

	it("copies the full hash", async () => {
		const user = userEvent.setup();
		const writeText = vi
			.spyOn(navigator.clipboard, "writeText")
			.mockResolvedValue(undefined);
		renderMenu(target());

		await user.click(screen.getByRole("button", { name: "Copy hash" }));

		expect(writeText).toHaveBeenCalledWith(HASH);
		expect(
			await screen.findByRole("button", { name: "Copied" }),
		).toBeInTheDocument();
	});

	it("amends through the commit sheet, with amend on", async () => {
		const user = userEvent.setup();
		const onClose = renderMenu(target({ refs: HEAD_REFS }));

		await user.click(screen.getByRole("button", { name: "Amend this commit" }));
		const sheet = screen.getByRole("dialog", { name: "Commit" });
		expect(sheet).toHaveTextContent("amending");
		expect(onClose).not.toHaveBeenCalled();

		await user.click(within(sheet).getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("creates a branch at the commit and switches to it", async () => {
		const user = userEvent.setup();
		const onClose = renderMenu(target());

		await user.click(
			screen.getByRole("button", { name: "Create branch here…" }),
		);
		const sheet = screen.getByRole("dialog", { name: "New branch" });
		expect(sheet).toHaveTextContent("Branches from abc1234 · Add lane layout");
		expect(sheet).toHaveTextContent(
			"Switches to the new branch at this commit.",
		);
		await user.type(within(sheet).getByLabelText("Name"), "fix/x");
		await user.click(within(sheet).getByRole("button", { name: "Create" }));

		expect(createBranch.mock.calls[0][0]).toEqual({
			name: "fix/x",
			start: HASH,
		});
		expect(onClose).toHaveBeenCalled();
	});

	// Paused, not absent: the sheet is where the reason is said.
	it("pauses creating a branch during an operation", async () => {
		const user = userEvent.setup();
		status = { staged: [], unstaged: [], operation: { kind: "rebase" } };
		renderMenu(target());

		await user.click(
			screen.getByRole("button", { name: "Create branch here…" }),
		);
		const sheet = screen.getByRole("dialog", { name: "New branch" });
		await user.type(within(sheet).getByLabelText("Name"), "fix/x");

		expect(
			within(sheet).getByRole("button", { name: "Create" }),
		).toBeDisabled();
		expect(sheet).toHaveTextContent(
			"Branch switching is paused during the rebase.",
		);
	});

	// The UI never runs the revert: a revert can stop on a conflict.
	it("hands the revert to the agent, on the branch HEAD is on", async () => {
		const user = userEvent.setup();
		const onClose = renderMenu(target());
		queryClient.setQueryData(gitBranchesQueryKey, {
			head: makeHead({ branch: "moved-on" }),
			local: [],
			remote_only: [],
			sync: makeSync(),
		});

		await user.click(screen.getByRole("button", { name: "Ask AI to revert" }));

		expect(prefill).toHaveBeenCalledWith(
			expect.stringMatching(
				/^Revert commit abc1234 "Add lane layout" on moved-on with git revert\./,
			),
		);
		expect(onClose).toHaveBeenCalled();
	});

	// The row says `Copied` first, so the press is seen to work.
	it("closes a second after copying", async () => {
		const user = userEvent.setup();
		vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
		const onClose = renderMenu(target());

		await user.click(screen.getByRole("button", { name: "Copy hash" }));
		await screen.findByRole("button", { name: "Copied" });
		expect(onClose).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(onClose).toHaveBeenCalled(), {
			timeout: 2000,
		});
	});

	// Creating a session for the text can take a while, and the menu's other
	// rows stay pressable meanwhile.
	it("leaves a sheet opened while the handoff was on its way", async () => {
		const user = userEvent.setup();
		let settle = () => {};
		prefill.mockReturnValue(
			new Promise<void>((resolve) => {
				settle = resolve;
			}),
		);
		const onClose = renderMenu(target());

		await user.click(screen.getByRole("button", { name: "Ask AI to revert" }));
		await user.click(
			screen.getByRole("button", { name: "Create branch here…" }),
		);
		await act(async () => settle());

		expect(screen.getByRole("dialog", { name: "New branch" })).toBeVisible();
		expect(onClose).not.toHaveBeenCalled();
	});

	// The menu has closed by then: the failure is said where it is mounted.
	it("says when the handoff failed, with no menu up", () => {
		handoffError = { summary: "Couldn't start a new chat", detail: null };
		renderMenu(null);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Couldn't start a new chat",
		);
	});
});
