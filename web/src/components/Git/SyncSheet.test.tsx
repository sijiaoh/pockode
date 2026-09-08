import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeSync } from "../../test/gitFixtures";
import type { GitSync } from "../../types/git";
import SyncSheet from "./SyncSheet";

function renderSheet(sync: Partial<GitSync> = {}) {
	const onFetch = vi.fn().mockResolvedValue(undefined);
	const onPull = vi.fn().mockResolvedValue(0);
	const onPush = vi.fn().mockResolvedValue(undefined);
	const onClose = vi.fn();

	render(
		<SyncSheet
			sync={makeSync(sync)}
			onClose={onClose}
			onFetch={onFetch}
			onPull={onPull}
			onPush={onPush}
		/>,
	);

	return { onFetch, onPull, onPush, onClose };
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
		const onPull = vi.fn().mockResolvedValue(3);

		render(
			<SyncSheet
				sync={makeSync({ behind: 2, head_pushed: true })}
				onClose={vi.fn()}
				onFetch={vi.fn()}
				onPull={onPull}
				onPush={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Pull (2)" }));

		expect(onPull).toHaveBeenCalled();
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
		const { onPush } = renderSheet({ upstream: "", head_pushed: false });

		expect(
			screen.getByText("This branch exists only on this machine."),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Publish branch" }));

		expect(onPush).toHaveBeenCalledWith(false);
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
		const { onPush } = renderSheet({ ahead: 1, behind: 2, head_pushed: false });

		await user.click(screen.getByRole("button", { name: "Push (force)" }));
		expect(onPush).not.toHaveBeenCalled();
		expect(
			screen.getByText(/Overwrites origin\/main with your local history/),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Force push" }));

		expect(onPush).toHaveBeenCalledWith(true);
	});

	it("keeps git's own message under the summary when pulling fails", async () => {
		const user = userEvent.setup();
		const onPull = vi
			.fn()
			.mockRejectedValue(
				new Error("fatal: Not possible to fast-forward, aborting."),
			);

		render(
			<SyncSheet
				sync={makeSync({ ahead: 1, behind: 2, head_pushed: false })}
				onClose={vi.fn()}
				onFetch={vi.fn()}
				onPull={onPull}
				onPush={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Pull (2)" }));

		const alert = await screen.findByRole("alert");
		// The escape hatch that exists on a phone is asking the agent in chat.
		expect(alert).toHaveTextContent(/Ask the agent in chat/);
		expect(alert).toHaveTextContent("fatal: Not possible to fast-forward");
	});

	// A slow relay link must not leave the user guessing, so the sheet cannot be
	// dismissed while an operation is in flight.
	it("locks itself down while an operation runs", async () => {
		const user = userEvent.setup();
		let release: () => void = () => {};
		const onFetch = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const onClose = vi.fn();

		render(
			<SyncSheet
				sync={makeSync({ behind: 2 })}
				onClose={onClose}
				onFetch={onFetch}
				onPull={vi.fn()}
				onPush={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Fetch" }));

		expect(screen.getByRole("button", { name: "Fetching…" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Pull (2)" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).not.toHaveBeenCalled();

		release();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Fetch" })).toBeEnabled(),
		);
	});
});
