import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitSyncActions } from "../../lib/gitSyncStore";
import { makeSync } from "../../test/gitFixtures";
import type { GitSync } from "../../types/git";
import SyncSheet from "./SyncSheet";

const fetchRemote = vi.fn();
const pull = vi.fn();
const push = vi.fn();
const wsState = { actions: { fetchRemote, pull, push } };

vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
}));

function renderSheet(sync: Partial<GitSync> = {}) {
	const onClose = vi.fn();
	const { unmount } = render(
		<QueryClientProvider client={new QueryClient()}>
			<SyncSheet sync={makeSync(sync)} onClose={onClose} />
		</QueryClientProvider>,
	);
	return { onClose, unmount };
}

/** The sync operations on offer, in the order they are rendered. */
function operations(): string[] {
	return (
		screen
			.getAllByRole("button")
			.map((b) => b.textContent ?? "")
			// The close button is icon-only, so an empty label is not an operation.
			.filter((label) => label !== "")
	);
}

describe("SyncSheet", () => {
	beforeEach(() => {
		gitSyncActions.reset();
		for (const fn of [fetchRemote, pull, push]) fn.mockReset();
		fetchRemote.mockResolvedValue(undefined);
		pull.mockResolvedValue(0);
		push.mockResolvedValue(undefined);
	});

	it("states the counts in words and when they were last refreshed", () => {
		renderSheet({ ahead: 1, behind: 2 });

		expect(screen.getByText("origin/main")).toBeInTheDocument();
		expect(
			screen.getByText("2 commits to pull · 1 commit to push"),
		).toBeInTheDocument();
		expect(screen.getByText(/Last fetched/)).toBeInTheDocument();
	});

	// "0 ahead, 0 behind" only means "up to date" as of the last fetch, so a
	// branch that has never fetched has to say so.
	it("says so when the branch has never fetched", () => {
		renderSheet({ last_fetch: null });

		expect(screen.getByText("Never fetched")).toBeInTheDocument();
	});

	// The button counts what the last fetch saw, but the outcome reports what the
	// pull's own fetch actually brought in — those differ whenever someone pushed
	// in between.
	it("reports the commits the pull actually brought in", async () => {
		const user = userEvent.setup();
		pull.mockResolvedValue(3);
		renderSheet({ behind: 2, head_pushed: true });

		await user.click(screen.getByRole("button", { name: "Pull (2)" }));

		expect(await screen.findByText("Pulled 3 commits.")).toBeInTheDocument();
	});

	// The counts are only as fresh as the last fetch, so "0 behind" is not a
	// reason to take pulling away — it is exactly when someone reaches for it.
	it("keeps pull available with nothing known to pull", () => {
		renderSheet({ last_fetch: null });

		expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
		// Fetch is the repair action for stale counts, so it stays available.
		expect(screen.getByRole("button", { name: "Fetch" })).toBeEnabled();
	});

	it("offers fetch, pull and push while an upstream is tracked", () => {
		renderSheet({ behind: 2, ahead: 1, head_pushed: false });

		expect(operations()).toEqual(["Fetch", "Pull (2)", "Push (force)"]);
	});

	// Pull is not "unavailable" without an upstream, it is inapplicable: a greyed
	// button would only take up the room the answer needs.
	it("drops pull entirely from an unpublished branch", () => {
		renderSheet({ upstream: "", head_pushed: false });

		expect(operations()).toEqual(["Publish branch", "Fetch"]);
	});

	// A configured upstream whose ref is missing here is more often a stale local
	// copy than a deleted remote branch, so repair leads.
	it("leads with fetch when the upstream ref is gone", () => {
		renderSheet({ upstream_gone: true });

		expect(operations()).toEqual(["Fetch", "Publish branch"]);
	});

	it("offers to publish a branch that has no upstream", async () => {
		const user = userEvent.setup();
		renderSheet({ upstream: "", head_pushed: false });

		expect(
			screen.getByText("This branch exists only on this machine."),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Publish branch" }));

		expect(push).toHaveBeenCalledWith(false);
		expect(await screen.findByText("Branch published.")).toBeInTheDocument();
	});

	// The upstream is configured but its ref is missing here, so the counts are
	// unknown — calling that "up to date" would be a lie.
	it("explains an upstream that is missing locally", () => {
		renderSheet({ upstream_gone: true });

		expect(
			screen.getByText(/origin\/main is missing here/),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Pull" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Publish branch" }),
		).toBeEnabled();
	});

	it("confirms before force pushing over a diverged remote", async () => {
		const user = userEvent.setup();
		renderSheet({ ahead: 1, behind: 2, head_pushed: false });

		await user.click(screen.getByRole("button", { name: "Push (force)" }));
		expect(push).not.toHaveBeenCalled();
		expect(
			screen.getByText(/Overwrites origin\/main with your local history/),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Force push" }));

		expect(push).toHaveBeenCalledWith(true);
	});

	// Both the sheet and the confirmation listen for Escape on document, and the
	// sheet registered first: without the sheet going undismissible, one key press
	// meant for the dialog would take the sheet down behind it.
	it("stays put while the force-push confirmation is up", async () => {
		const user = userEvent.setup();
		const { onClose } = renderSheet({
			ahead: 1,
			behind: 2,
			head_pushed: false,
		});

		await user.click(screen.getByRole("button", { name: "Push (force)" }));
		await user.keyboard("{Escape}");

		// The key press went to the dialog, and only to the dialog.
		expect(screen.queryByText(/Overwrites origin\/main/)).toBeNull();
		expect(onClose).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
	});

	it("keeps git's own message under the summary when pulling fails", async () => {
		const user = userEvent.setup();
		pull.mockRejectedValue(
			new Error("fatal: Not possible to fast-forward, aborting."),
		);
		renderSheet({ ahead: 1, behind: 2, head_pushed: false });

		await user.click(screen.getByRole("button", { name: "Pull (2)" }));

		const alert = await screen.findByRole("alert");
		// The escape hatch that exists on a phone is asking the agent in chat.
		expect(alert).toHaveTextContent(/Ask the agent in chat/);
		expect(alert).toHaveTextContent("fatal: Not possible to fast-forward");
	});

	// Closing is leaving, not cancelling: the operation keeps running and the
	// panel keeps reporting it.
	it("can be closed while an operation runs", async () => {
		const user = userEvent.setup();
		pull.mockReturnValue(new Promise(() => {}));
		const { onClose } = renderSheet({ behind: 2 });

		await user.click(screen.getByRole("button", { name: "Pull (2)" }));

		expect(screen.getByRole("button", { name: "Pulling…" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});

	// Reopening must land on the run that is still going, not on a fresh panel
	// whose buttons invite a second one.
	it("shows the same run again after being closed and reopened", async () => {
		const user = userEvent.setup();
		pull.mockReturnValue(new Promise(() => {}));
		const { unmount } = renderSheet({ behind: 2 });

		await user.click(screen.getByRole("button", { name: "Pull (2)" }));
		unmount();
		renderSheet({ behind: 2 });

		expect(screen.getByRole("button", { name: "Pulling…" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Fetch" })).toBeDisabled();
		expect(pull).toHaveBeenCalledTimes(1);
	});

	// The outcome outlives the sheet too, so reopening after a run has settled
	// still answers "what happened".
	it("still shows the outcome of a run that settled while it was closed", async () => {
		const user = userEvent.setup();
		const { unmount } = renderSheet({ behind: 2 });

		await user.click(screen.getByRole("button", { name: "Pull (2)" }));
		await waitFor(() =>
			expect(screen.getByText("Already up to date.")).toBeInTheDocument(),
		);

		unmount();
		renderSheet({ behind: 2 });

		expect(screen.getByText("Already up to date.")).toBeInTheDocument();
	});
});
