import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { describe, expect, it, vi } from "vitest";
import type { StagedSubmodule } from "../../types/git";
import CommitSheet, {
	type CommitDraft,
	type CommitPush,
	type LastCommit,
} from "./CommitSheet";

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
		push?: CommitPush | null;
		draft?: CommitDraft["run"];
		paused?: string | null;
		onCommit?: (
			message: string,
			amend: boolean,
			push: boolean,
		) => Promise<void>;
	} = {},
) {
	const onCommit = props.onCommit ?? vi.fn().mockResolvedValue(undefined);
	const onClose = vi.fn();
	const runDraft = props.draft ?? vi.fn().mockResolvedValue("Drafted");

	const view = render(
		<CommitSheet
			stagedCount={props.stagedCount ?? 2}
			submodules={props.submodules ?? []}
			lastCommit={props.lastCommit === undefined ? null : props.lastCommit}
			amendInitially={props.amendInitially ?? false}
			push={props.push === undefined ? null : props.push}
			draft={{ agentLabel: "Claude", run: runDraft }}
			paused={props.paused ?? null}
			onClose={onClose}
			onCommit={onCommit}
		/>,
	);

	return { onCommit, onClose, runDraft, unmount: view.unmount };
}

const message = () => screen.getByRole("textbox", { name: "Commit message" });
const commitButton = () => screen.getByRole("button", { name: "Commit" });
const pushButton = () => screen.getByRole("button", { name: "Commit & push" });

const PUSH: CommitPush = { publishes: false, blocked: null };
const amendToggle = () =>
	screen.getByRole("checkbox", { name: "Amend last commit" });

describe("CommitSheet", () => {
	// An operation that began with the sheet open: the message stays, both
	// commits stop, and the footer says why.
	it("disables committing with the reason while paused", async () => {
		const user = userEvent.setup();
		renderSheet({ push: PUSH, paused: "Can't commit during a rebase." });

		await user.type(message(), "Fix it");

		expect(commitButton()).toBeDisabled();
		expect(pushButton()).toBeDisabled();
		expect(commitButton()).toHaveAccessibleDescription(
			"Can't commit during a rebase.",
		);
		expect(message()).toHaveValue("Fix it");
	});

	it("commits the typed message", async () => {
		const user = userEvent.setup();
		const { onCommit } = renderSheet({ stagedCount: 2 });

		expect(screen.getByText("2 files staged")).toBeInTheDocument();
		expect(commitButton()).toBeDisabled();

		await user.type(message(), "Fix it");
		await user.click(commitButton());

		expect(onCommit).toHaveBeenCalledWith("Fix it", false, false);
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

	it("agrees with itself about a single excluded file", () => {
		renderSheet({
			stagedCount: 1,
			submodules: [{ path: "vendor/sdk", count: 1 }],
		});

		expect(
			screen.getByText("1 staged file in vendor/sdk is not included"),
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
		expect(onCommit).toHaveBeenCalledWith(LAST_COMMIT.message, true, false);
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
				"This commit is already on origin/main — pushing afterwards needs a force push from Sync.",
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

	describe("Commit & push", () => {
		it("commits and asks for the push in one press", async () => {
			const user = userEvent.setup();
			const { onCommit } = renderSheet({ push: PUSH });

			await user.type(message(), "Fix it");
			await user.click(pushButton());

			expect(onCommit).toHaveBeenCalledWith("Fix it", false, true);
		});

		// Nowhere to push to: a button that could never work is left out, not
		// greyed.
		it("is absent without a sync status", () => {
			renderSheet({ push: null });

			expect(
				screen.queryByRole("button", { name: /Commit &/ }),
			).not.toBeInTheDocument();
		});

		it("names publishing for a branch with no upstream", () => {
			renderSheet({ push: { publishes: true, blocked: null } });

			expect(
				screen.getByRole("button", { name: "Commit & publish" }),
			).toBeInTheDocument();
		});

		it("says on screen why the push cannot follow", async () => {
			const user = userEvent.setup();
			const blocked =
				"origin/main has 2 commits this branch does not — pull before pushing.";
			renderSheet({ push: { publishes: false, blocked } });

			await user.type(message(), "Fix it");

			expect(pushButton()).toBeDisabled();
			expect(pushButton()).toHaveAccessibleDescription(blocked);
			expect(commitButton()).toBeEnabled();
		});

		// The rewritten commit would need a force push, which stays behind the
		// Sync sheet's confirmation.
		it("is disabled while amending a pushed commit", async () => {
			const user = userEvent.setup();
			renderSheet({
				push: PUSH,
				lastCommit: { ...LAST_COMMIT, pushedTo: "origin/main" },
			});

			await user.click(amendToggle());

			expect(pushButton()).toBeDisabled();
			expect(pushButton()).toHaveAccessibleDescription(/needs a force push/);
			expect(commitButton()).toBeEnabled();
		});

		// The message is the one thing the user cannot get back, so the sheet
		// holds shut until the commit has answered.
		it("holds the sheet while committing and spins only the pressed button", async () => {
			const user = userEvent.setup();
			let finish = () => {};
			const onCommit = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			const { onClose } = renderSheet({ push: PUSH, onCommit });

			await user.type(message(), "Fix it");
			await user.click(pushButton());

			expect(
				screen.getByRole("button", { name: "Committing…" }),
			).toBeDisabled();
			expect(commitButton()).toBeDisabled();
			expect(message()).toBeDisabled();
			await user.keyboard("{Escape}");
			expect(onClose).not.toHaveBeenCalled();

			finish();
			await waitFor(() => expect(pushButton()).toBeEnabled());
		});
	});

	describe("title length hint", () => {
		const hint = () => screen.queryByText(/^Title \d+ \/ 72$/);

		it("stays out of the way of a short title", async () => {
			const user = userEvent.setup();
			renderSheet();

			await user.type(message(), "x".repeat(49));

			expect(hint()).not.toBeInTheDocument();
		});

		// Only the first line is the title; the body can be as long as it likes.
		it("counts the first line from 50 on", async () => {
			const user = userEvent.setup();
			renderSheet();

			await user.type(
				message(),
				`${"x".repeat(50)}{Enter}{Enter}${"y".repeat(80)}`,
			);

			expect(hint()).toHaveTextContent("Title 50 / 72");
			expect(message()).not.toHaveAttribute("aria-describedby");
		});

		// Code points, so a title in Chinese or with emoji is not counted double.
		it("counts characters rather than UTF-16 units", async () => {
			const user = userEvent.setup();
			renderSheet();

			await user.type(message(), "😀".repeat(60));

			expect(hint()).toHaveTextContent("Title 60 / 72");
		});

		it("is read out past 72, and still never blocks the commit", async () => {
			const user = userEvent.setup();
			renderSheet();

			await user.type(message(), "x".repeat(73));

			expect(message()).toHaveAccessibleDescription("Title 73 / 72");
			expect(commitButton()).toBeEnabled();
		});
	});

	describe("AI draft", () => {
		const draftButton = () => screen.getByRole("button", { name: "Draft" });

		function deferred() {
			let resolve: (text: string) => void = () => {};
			let reject: (err: unknown) => void = () => {};
			const promise = new Promise<string>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			return { promise, resolve, reject };
		}

		const draftFailure = (reason: string, text = "boom") =>
			new JSONRPCErrorException(text, -32004, { reason });

		// The draft is read before it is recorded: it fills the box and nothing
		// else, and the press is answered without pulling the keyboard up.
		it("fills an empty box with the draft and commits nothing", async () => {
			const user = userEvent.setup();
			const { runDraft, onCommit } = renderSheet();

			await user.click(draftButton());

			await waitFor(() => expect(message()).toHaveValue("Drafted"));
			expect(runDraft).toHaveBeenCalledWith(false, expect.any(AbortSignal));
			expect(onCommit).not.toHaveBeenCalled();
			expect(draftButton()).toHaveFocus();
			expect(screen.getByText("Draft inserted")).toBeInTheDocument();
		});

		it("drafts the amended commit with nothing staged", async () => {
			const user = userEvent.setup();
			const { runDraft } = renderSheet({
				stagedCount: 0,
				lastCommit: LAST_COMMIT,
				amendInitially: true,
			});

			await user.click(draftButton());

			expect(runDraft).toHaveBeenCalledWith(true, expect.any(AbortSignal));
			// The untouched prefill is not the user's: replaced without asking.
			await waitFor(() => expect(message()).toHaveValue("Drafted"));
		});

		it("is dead, and says why, where there is nothing to describe", () => {
			renderSheet({ stagedCount: 0, lastCommit: LAST_COMMIT });

			expect(
				screen.getByRole("button", {
					name: "Draft a message (nothing staged)",
				}),
			).toBeDisabled();
		});

		it("asks before replacing what the user wrote", async () => {
			const user = userEvent.setup();
			const { runDraft } = renderSheet();

			await user.type(message(), "fix: mine");
			await user.click(draftButton());

			expect(runDraft).not.toHaveBeenCalled();
			const replace = screen.getByRole("button", { name: "Replace" });
			expect(replace).toHaveFocus();

			await user.click(screen.getByRole("button", { name: "Keep mine" }));
			expect(message()).toHaveValue("fix: mine");
			expect(draftButton()).toHaveFocus();

			await user.click(draftButton());
			await user.click(screen.getByRole("button", { name: "Replace" }));
			await waitFor(() => expect(message()).toHaveValue("Drafted"));
		});

		it("redrafts an untouched draft without asking, but not an edited one", async () => {
			const user = userEvent.setup();
			const { runDraft } = renderSheet();

			await user.click(draftButton());
			await waitFor(() => expect(message()).toHaveValue("Drafted"));
			await user.click(draftButton());
			await waitFor(() => expect(runDraft).toHaveBeenCalledTimes(2));

			await user.type(message(), "!");
			await user.click(draftButton());
			expect(
				screen.getByRole("button", { name: "Replace" }),
			).toBeInTheDocument();
		});

		// The strip claims Escape, so the sheet under it stays open.
		it("keeps the message on Escape without closing the sheet", async () => {
			const user = userEvent.setup();
			const { onClose } = renderSheet();

			await user.type(message(), "fix: mine");
			await user.click(draftButton());
			await user.keyboard("{Escape}");

			expect(
				screen.queryByRole("button", { name: "Replace" }),
			).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
			expect(message()).toHaveValue("fix: mine");
		});

		it("holds the message still while drafting, and Stop ends it quietly", async () => {
			const user = userEvent.setup();
			const pending = deferred();
			const runDraft = vi.fn().mockReturnValue(pending.promise);
			renderSheet({ lastCommit: LAST_COMMIT, draft: runDraft });

			await user.click(draftButton());

			expect(screen.getByText("Drafting with Claude…")).toBeInTheDocument();
			expect(message()).toHaveAttribute("readonly");
			expect(commitButton()).toBeDisabled();
			expect(amendToggle()).toBeDisabled();

			const stop = screen.getByRole("button", { name: "Stop" });
			expect(stop).toHaveFocus();
			await user.click(stop);

			const signal: AbortSignal = runDraft.mock.calls[0][1];
			expect(signal.aborted).toBe(true);
			expect(draftButton()).toHaveFocus();
			expect(message()).not.toHaveAttribute("readonly");

			// An answer that comes anyway lands nowhere.
			await act(async () => pending.resolve("Too late"));
			expect(message()).toHaveValue("");
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});

		// Drafting holds nothing irreversible, so the sheet does not refuse to
		// close — and closing stops the paid call it would otherwise leave running.
		it("can be closed while drafting, which cancels it", async () => {
			const user = userEvent.setup();
			const runDraft = vi.fn().mockReturnValue(deferred().promise);
			const { onClose, unmount } = renderSheet({ draft: runDraft });

			await user.click(draftButton());
			await user.click(screen.getByRole("button", { name: /close/i }));
			expect(onClose).toHaveBeenCalled();

			unmount();
			expect(runDraft.mock.calls[0][1].aborted).toBe(true);
		});

		it.each([
			["timeout", "Drafting took too long and was stopped."],
			[
				"auth_failed",
				"Could not draft: Claude is not signed in. Sign in under Settings → AI CLIs.",
			],
			["cli_not_found", "Could not draft: Claude is not installed."],
			["nothing_staged", "Nothing is staged any more."],
			["empty", "The AI returned an empty message. Try again."],
		])("says what went wrong on %s", async (reason, text) => {
			const user = userEvent.setup();
			renderSheet({
				draft: vi.fn().mockRejectedValue(draftFailure(reason)),
			});

			await user.click(draftButton());

			expect(await screen.findByRole("alert")).toHaveTextContent(text);
			expect(message()).toHaveValue("");
		});

		it("quotes the CLI when it fails", async () => {
			const user = userEvent.setup();
			renderSheet({
				draft: vi
					.fn()
					.mockRejectedValue(draftFailure("failed", "usage limit reached")),
			});

			await user.click(draftButton());

			const alert = await screen.findByRole("alert");
			expect(alert).toHaveTextContent("Could not draft a message.");
			expect(alert).toHaveTextContent("usage limit reached");
		});

		it("reports nothing for a draft the server cancelled", async () => {
			const user = userEvent.setup();
			const pending = deferred();
			renderSheet({ draft: vi.fn().mockReturnValue(pending.promise) });

			await user.click(draftButton());
			await act(async () => pending.reject(draftFailure("cancelled")));

			expect(draftButton()).toBeEnabled();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});

		it("leaves everything as it was for a draft dropped from outside", async () => {
			const user = userEvent.setup();
			renderSheet({ draft: vi.fn().mockResolvedValue(null) });

			await user.click(draftButton());

			await waitFor(() => expect(draftButton()).toBeEnabled());
			expect(message()).toHaveValue("");
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});

		it("does not draft from the strip while a commit runs", async () => {
			const user = userEvent.setup();
			const runDraft = vi.fn().mockResolvedValue("Drafted");
			renderSheet({
				draft: runDraft,
				onCommit: vi.fn().mockReturnValue(deferred().promise),
			});

			await user.type(message(), "fix: mine");
			await user.click(draftButton());
			await user.click(commitButton());

			expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
		});

		// The engine can resolve differently mid-run — a session's detail
		// arriving after the press — and the row names the CLI actually asked.
		it("keeps naming the CLI it asked", async () => {
			const user = userEvent.setup();
			const run = vi.fn().mockReturnValue(deferred().promise);
			const sheet = (agentLabel: string) => (
				<CommitSheet
					stagedCount={1}
					submodules={[]}
					lastCommit={null}
					amendInitially={false}
					push={null}
					draft={{ agentLabel, run }}
					paused={null}
					onClose={vi.fn()}
					onCommit={vi.fn()}
				/>
			);
			const { rerender } = render(sheet("Claude"));

			await user.click(draftButton());
			rerender(sheet("Codex"));

			expect(screen.getByText("Drafting with Claude…")).toBeInTheDocument();
		});

		// A draft written with amend on describes HEAD's changes too, which a
		// plain commit would not record.
		it("takes back an untouched amend draft when amend goes off", async () => {
			const user = userEvent.setup();
			renderSheet({ lastCommit: LAST_COMMIT });

			await user.click(amendToggle());
			await user.click(draftButton());
			await waitFor(() => expect(message()).toHaveValue("Drafted"));

			await user.click(amendToggle());
			expect(message()).toHaveValue("");
		});

		it("keeps a plain draft across amend going on and off", async () => {
			const user = userEvent.setup();
			renderSheet({ lastCommit: LAST_COMMIT });

			await user.click(draftButton());
			await waitFor(() => expect(message()).toHaveValue("Drafted"));

			await user.click(amendToggle());
			await user.click(amendToggle());
			expect(message()).toHaveValue("Drafted");
		});

		// One block per source: a commit failure stays while a draft runs.
		it("keeps a commit failure on screen apart from the draft's", async () => {
			const user = userEvent.setup();
			renderSheet({
				onCommit: vi.fn().mockRejectedValue(new Error("hook said no")),
				draft: vi.fn().mockRejectedValue(draftFailure("empty")),
			});

			await user.type(message(), "Fix it");
			await user.click(commitButton());
			await screen.findByText("hook said no");

			await user.click(draftButton());
			await user.click(screen.getByRole("button", { name: "Replace" }));

			await screen.findByText("The AI returned an empty message. Try again.");
			expect(screen.getByText("hook said no")).toBeInTheDocument();
		});
	});
});
