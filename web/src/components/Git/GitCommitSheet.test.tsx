import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitSyncActions, useGitSyncStore } from "../../lib/gitSyncStore";
import { useSessionDetailStore } from "../../lib/sessionDetailStore";
import { useSettingsStore } from "../../lib/settingsStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import { makeHead, makeSync } from "../../test/gitFixtures";
import { makeSessionDetail } from "../../test/sessionFixtures";
import type { GitBranches, GitStatus } from "../../types/git";
import GitCommitSheet from "./GitCommitSheet";

const commit = vi.fn();
const push = vi.fn();
const draftCommitMessage = vi.fn();
const cancelCommitDraft = vi.fn();
const wsState = {
	actions: { commit, push, draftCommitMessage, cancelCommitDraft },
};

const timedOut = new Error("Request timed out");
vi.mock("../../lib/wsStore", () => ({
	isRPCTimeout: (error: unknown) => error === timedOut,
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
}));

const status: GitStatus = {
	staged: [{ path: "a.ts", status: "M" }],
	unstaged: [],
};
let branches: GitBranches;

vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));
vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches }),
}));

let routeSessionId: string | null = null;
vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ sessionId: routeSessionId }),
}));

function renderSheet() {
	const onClose = vi.fn();
	const { unmount } = render(
		<QueryClientProvider client={new QueryClient()}>
			<GitCommitSheet amendInitially={false} onClose={onClose} />
		</QueryClientProvider>,
	);
	return { onClose, unmount };
}

const pushRun = () => useGitSyncStore.getState().runs[""];

describe("GitCommitSheet", () => {
	beforeEach(() => {
		gitSyncActions.reset();
		commit.mockReset();
		push.mockReset();
		draftCommitMessage.mockReset();
		cancelCommitDraft.mockReset().mockResolvedValue(undefined);
		routeSessionId = null;
		useSessionDetailStore.getState().clear();
		useSettingsStore.getState().reset();
		useWorktreeStore.setState({ current: "" });
		branches = {
			head: makeHead(),
			local: [],
			remote_only: [],
			sync: makeSync({ ahead: 1 }),
		};
	});

	// The push belongs to the sync store from here on, so the sheet can close
	// and the chip, banner and Sync sheet report it like any other push.
	it("hands the push to the sync store once the commit is in", async () => {
		const user = userEvent.setup();
		commit.mockResolvedValue(undefined);
		push.mockResolvedValue(undefined);
		const { onClose } = renderSheet();

		await user.type(screen.getByRole("textbox"), "Fix it");
		await user.click(screen.getByRole("button", { name: "Commit & push" }));

		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(commit).toHaveBeenCalledWith("Fix it", false);
		expect(push).toHaveBeenCalledWith(false);
		// The commit just made is one of those it sent.
		await waitFor(() =>
			expect(pushRun()?.outcome).toEqual({
				kind: "success",
				message: "Pushed 2 commits.",
			}),
		);
	});

	it("pushes nothing when the commit fails", async () => {
		const user = userEvent.setup();
		commit.mockRejectedValue(new Error("pre-commit hook failed"));
		const { onClose } = renderSheet();

		await user.type(screen.getByRole("textbox"), "Fix it");
		await user.click(screen.getByRole("button", { name: "Commit & push" }));

		expect(
			await screen.findByText("pre-commit hook failed"),
		).toBeInTheDocument();
		expect(push).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("offers no push without a remote", () => {
		branches.sync = makeSync({ has_remote: false });
		renderSheet();

		expect(
			screen.queryByRole("button", { name: /Commit &/ }),
		).not.toBeInTheDocument();
	});

	describe("AI draft", () => {
		const draftButton = () => screen.getByRole("button", { name: "Draft" });
		const pendingDraft = () =>
			draftCommitMessage.mockReturnValue(new Promise(() => {}));

		// The engine of the chat the workspace was opened over: the user already
		// chose it, and the label names the one that is billed.
		it("drafts with the session the workspace was opened over", async () => {
			const user = userEvent.setup();
			routeSessionId = "s1";
			useSessionDetailStore.getState().setDetail(
				"s1",
				makeSessionDetail({
					agent_type: "codex",
					model: "m",
					effort: "high",
				}),
			);
			pendingDraft();
			renderSheet();

			await user.click(draftButton());

			expect(screen.getByText("Drafting with Codex…")).toBeInTheDocument();
			expect(draftCommitMessage).toHaveBeenCalledWith({
				draftId: expect.any(String),
				agentType: "codex",
				model: "m",
				effort: "high",
				amend: false,
			});
		});

		it("falls back to the global default without that session", async () => {
			const user = userEvent.setup();
			routeSessionId = "gone";
			useSettingsStore.getState().setSettings({
				default_agent_type: "codex",
				default_model: "gm",
				default_effort: "",
			} as Parameters<
				ReturnType<typeof useSettingsStore.getState>["setSettings"]
			>[0]);
			draftCommitMessage.mockResolvedValue("Drafted");
			renderSheet();

			await user.click(draftButton());

			await waitFor(() =>
				expect(screen.getByRole("textbox")).toHaveValue("Drafted"),
			);
			expect(draftCommitMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: "codex",
					model: "gm",
					effort: "",
				}),
			);
		});

		it("cancels the draft it started on Stop", async () => {
			const user = userEvent.setup();
			pendingDraft();
			renderSheet();

			await user.click(draftButton());
			await user.click(screen.getByRole("button", { name: "Stop" }));

			const { draftId } = draftCommitMessage.mock.calls[0][0];
			expect(cancelCommitDraft).toHaveBeenCalledWith(draftId);
		});

		it("cancels once when the sheet goes away mid-draft", async () => {
			const user = userEvent.setup();
			pendingDraft();
			const { unmount } = renderSheet();

			await user.click(draftButton());
			unmount();

			expect(cancelCommitDraft).toHaveBeenCalledTimes(1);
		});

		// The server's 90s start after git has read the change, so our own
		// clock can run out first while the CLI is still billing.
		it("cancels the draft it stopped waiting for", async () => {
			const user = userEvent.setup();
			draftCommitMessage.mockRejectedValue(timedOut);
			renderSheet();

			await user.click(draftButton());

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Could not draft a message.",
			);
			const { draftId } = draftCommitMessage.mock.calls[0][0];
			expect(cancelCommitDraft).toHaveBeenCalledWith(draftId);
		});

		// The connection outlives a worktree switch, so nothing else would stop
		// a draft of the worktree left behind.
		it("cancels the draft when the worktree changes, and drops its answer", async () => {
			const user = userEvent.setup();
			let answer: (text: string) => void = () => {};
			draftCommitMessage.mockReturnValue(
				new Promise<string>((resolve) => {
					answer = resolve;
				}),
			);
			renderSheet();

			await user.click(draftButton());
			act(() => useWorktreeStore.setState({ current: "other" }));

			const { draftId } = draftCommitMessage.mock.calls[0][0];
			expect(cancelCommitDraft).toHaveBeenCalledWith(draftId);

			// The answer beat the cancel to the server: it describes the
			// worktree that was left, so it fills nothing here.
			await act(async () => answer("Old worktree's draft"));
			expect(screen.getByRole("textbox")).toHaveValue("");
			expect(draftButton()).toBeEnabled();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});
	});
});
