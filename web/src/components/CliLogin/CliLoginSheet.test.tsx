import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliLoginActions, useCliLoginStore } from "../../lib/cliLoginStore";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeLogin,
	resetCliLoginStore,
} from "../../test/cliAuthFixtures";
import type { CliLogin, CliLoginFailureReason } from "../../types/cliAuth";
import CliLoginSheet from "./CliLoginSheet";

const ws = vi.hoisted(() => ({ actions: {} as Record<string, unknown> }));

vi.mock("../../lib/wsStore", () => {
	const state = () => ({ status: "connected", actions: ws.actions });
	return {
		useWSStore: Object.assign(
			(selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
			{ getState: state },
		),
	};
});

let server: FakeCliAuth;

beforeEach(() => {
	resetCliLoginStore();
	localStorage.clear();
	server = createFakeCliAuth();
	ws.actions = server.actions;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const DEVICE_URL = "https://auth.openai.com/codex/device";
const CLAUDE_URL =
	"https://claude.com/cai/oauth/authorize?code=true&state=secret-state";

function codexWaiting(overrides = {}) {
	return makeLogin({
		id: "codex-1",
		agent: "codex",
		phase: "waiting",
		url: DEVICE_URL,
		user_code: "ABCD-12345",
		...overrides,
	});
}

function claudeWaiting(overrides = {}) {
	return makeLogin({
		id: "claude-1",
		agent: "claude",
		account_kind: "claude_ai",
		phase: "waiting",
		url: CLAUDE_URL,
		...overrides,
	});
}

describe("CliLoginSheet", () => {
	describe("starting", () => {
		it("starts a sign-in when the CLI is signed out, and finishes on its own", async () => {
			server.setStatuses([{ agent: "codex", state: "signed_out" }]);
			server.actions.cliLoginStart.mockResolvedValue(codexWaiting());
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);

			expect(await screen.findByText("ABCD-12345")).toBeInTheDocument();
			expect(server.actions.cliLoginStart).toHaveBeenCalledWith(
				"codex",
				undefined,
			);
			expect(
				screen.getByRole("link", { name: /Open sign-in page/ }),
			).toHaveAttribute("href", DEVICE_URL);
			expect(screen.getByText(/Expires in \d+:\d\d/)).toBeInTheDocument();

			// The user finishes in the browser; nothing is pressed in Pockode.
			server.push(
				codexWaiting({
					revision: 2,
					phase: "succeeded",
					url: undefined,
					user_code: undefined,
					account: { email: "ada@example.com", plan: "plus" },
				}),
			);

			expect(
				await screen.findByRole("heading", { name: "Signed in to Codex" }),
			).toBeInTheDocument();
			expect(screen.getByText("ada@example.com · Plus")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
		});

		// After a reload the user's own flow looks exactly like someone else's;
		// replacing it would throw away the code already typed in the browser.
		it("resumes a running sign-in instead of starting another", async () => {
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(codexWaiting());
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);

			expect(await screen.findByText("ABCD-12345")).toBeInTheDocument();
			expect(server.actions.cliLoginStart).not.toHaveBeenCalled();
		});

		// How an old failure notice's button stays honest.
		it("says so when the CLI is already signed in, and starts nothing", async () => {
			server.setStatuses([
				{
					agent: "claude",
					state: "signed_in",
					account: { email: "ada@example.com", plan: "max" },
				},
			]);
			render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);

			expect(
				await screen.findByRole("heading", {
					name: "Claude is already signed in as ada@example.com",
				}),
			).toBeInTheDocument();
			expect(server.actions.cliLoginStart).not.toHaveBeenCalled();
		});

		it("offers a retry, not a sign-in, when status cannot be read", async () => {
			server.setStatuses([
				{ agent: "codex", state: "unavailable", error: "app-server exited" },
			]);
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);

			expect(
				await screen.findByRole("heading", {
					name: "Couldn't read sign-in status",
				}),
			).toBeInTheDocument();
			expect(screen.getByText("app-server exited")).toBeInTheDocument();

			server.setStatuses([{ agent: "codex", state: "signed_out" }]);
			server.actions.cliLoginStart.mockResolvedValue(codexWaiting());
			await userEvent
				.setup()
				.click(screen.getByRole("button", { name: "Retry" }));

			expect(await screen.findByText("ABCD-12345")).toBeInTheDocument();
		});

		// The CLI's files are being replaced: nothing that runs it is offered.
		it("starts no sign-in while the CLI is being updated", async () => {
			server.setStatuses([
				{ agent: "codex", state: "updating", update_id: "update-1" },
			]);
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);

			expect(
				await screen.findByRole("heading", { name: "Codex is being updated" }),
			).toBeInTheDocument();
			expect(server.actions.cliLoginStart).not.toHaveBeenCalled();
		});
	});

	describe("only Cancel cancels", () => {
		beforeEach(() => {
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(codexWaiting());
		});

		it.each([
			[
				"the close button",
				(user: ReturnType<typeof userEvent.setup>) =>
					user.click(screen.getByRole("button", { name: "Close" })),
			],
			[
				"the backdrop",
				(user: ReturnType<typeof userEvent.setup>) => {
					const backdrop = screen.getByRole("dialog").firstElementChild;
					if (!backdrop) throw new Error("no backdrop");
					return user.click(backdrop);
				},
			],
			[
				"Escape",
				(user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}"),
			],
		])("closes on %s and leaves the sign-in running", async (_, dismiss) => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			render(<CliLoginSheet agent="codex" onClose={onClose} />);
			await screen.findByText("ABCD-12345");

			await dismiss(user);

			expect(onClose).toHaveBeenCalled();
			expect(server.actions.cliLoginCancel).not.toHaveBeenCalled();
		});

		it("ends the sign-in on the server and closes on Cancel", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			server.actions.cliLoginCancel.mockResolvedValue(
				codexWaiting({ revision: 2, phase: "canceled" }),
			);
			render(<CliLoginSheet agent="codex" onClose={onClose} />);
			await screen.findByText("ABCD-12345");

			await user.click(screen.getByRole("button", { name: "Cancel" }));

			expect(server.actions.cliLoginCancel).toHaveBeenCalledWith("codex-1");
			expect(onClose).toHaveBeenCalled();
		});

		it("stays open and says so when the cancel fails", async () => {
			const user = userEvent.setup();
			const onClose = vi.fn();
			server.actions.cliLoginCancel.mockRejectedValue(
				new Error("Not connected"),
			);
			render(<CliLoginSheet agent="codex" onClose={onClose} />);
			await screen.findByText("ABCD-12345");

			await user.click(screen.getByRole("button", { name: "Cancel" }));

			expect(
				await screen.findByText("Couldn't cancel the sign-in: Not connected"),
			).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe("Claude's pasted code", () => {
		beforeEach(() => {
			server.setStatuses([
				{ agent: "claude", state: "signing_in", login_id: "claude-1" },
			]);
			server.setLatest(claudeWaiting());
		});

		it("sends the trimmed code and shows it being verified", async () => {
			const user = userEvent.setup();
			server.actions.cliLoginSubmitCode.mockResolvedValue(
				claudeWaiting({ revision: 2, phase: "verifying" }),
			);
			render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);

			await user.type(
				await screen.findByRole("textbox", { name: "Sign-in code" }),
				"  abc#def  ",
			);
			await user.click(screen.getByRole("button", { name: "Sign in" }));

			expect(server.actions.cliLoginSubmitCode).toHaveBeenCalledWith(
				"claude-1",
				"abc#def",
			);
			expect(
				await screen.findByRole("button", { name: "Verifying…" }),
			).toBeDisabled();
			expect(
				screen.getByRole("textbox", { name: "Sign-in code" }),
			).toHaveAttribute("readonly");
		});

		// One paste away from trying again: the field keeps what was pasted, all
		// of it selected so the next paste replaces it.
		it("keeps and selects an incomplete code the CLI asked for again", async () => {
			const user = userEvent.setup();
			server.actions.cliLoginSubmitCode.mockResolvedValue(
				claudeWaiting({ revision: 2, phase: "verifying" }),
			);
			render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);
			const field = await screen.findByRole("textbox", {
				name: "Sign-in code",
			});
			await user.type(field, "abc");
			await user.click(screen.getByRole("button", { name: "Sign in" }));

			server.push(claudeWaiting({ revision: 3, code_malformed: true }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"That code wasn't accepted.",
			);
			expect(field).toHaveValue("abc");
			expect((field as HTMLInputElement).selectionStart).toBe(0);
			expect((field as HTMLInputElement).selectionEnd).toBe(3);
		});

		it("restarts as a Console sign-in on request", async () => {
			const user = userEvent.setup();
			server.actions.cliLoginCancel.mockResolvedValue(
				claudeWaiting({ revision: 2, phase: "canceled" }),
			);
			server.actions.cliLoginStart.mockResolvedValue(
				claudeWaiting({ id: "claude-2", account_kind: "console" }),
			);
			render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);

			await user.click(
				await screen.findByRole("button", {
					name: "Use an Anthropic Console account instead",
				}),
			);

			expect(server.actions.cliLoginCancel).toHaveBeenCalledWith("claude-1");
			expect(server.actions.cliLoginStart).toHaveBeenCalledWith(
				"claude",
				"console",
			);
			expect(
				await screen.findByRole("button", {
					name: "Use a Claude subscription instead",
				}),
			).toBeInTheDocument();
		});
	});

	describe("failures", () => {
		it.each<[CliLoginFailureReason, string, string, string | null]>([
			[
				"code_rejected",
				"That code wasn't accepted",
				"Check you pasted all of it",
				"Start again",
			],
			[
				"expired",
				"This sign-in expired",
				"Start again to get a new one",
				"Start again",
			],
			[
				"device_auth_failed",
				"Codex couldn't finish the sign-in",
				"device code authorization",
				"Start again",
			],
			[
				"not_installed",
				"Codex isn't installed",
				"on the machine running Pockode",
				null,
			],
			[
				"flow_broken",
				"Pockode couldn't run the sign-in for Codex 0.153.0",
				"codex login",
				null,
			],
			["other", "Sign-in failed", "socket closed", "Try again"],
		])("%s: says what happened and what to do", async (reason, title, body, retry) => {
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(
				codexWaiting({
					phase: "failed",
					version: "0.153.0",
					url: undefined,
					user_code: undefined,
					failure: { reason, detail: "socket closed" },
				}),
			);
			// Status names the sign-in as running, but by the time the sheet
			// subscribes it has already failed.
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);

			expect(
				await screen.findByRole("heading", { name: title }),
			).toBeInTheDocument();
			expect(screen.getByText(new RegExp(body))).toBeInTheDocument();
			// No way forward is offered that the failure cannot take.
			for (const offer of ["Start again", "Try again"]) {
				if (offer === retry) {
					expect(
						screen.getByRole("button", { name: offer }),
					).toBeInTheDocument();
				} else {
					expect(
						screen.queryByRole("button", { name: offer }),
					).not.toBeInTheDocument();
				}
			}
			// Beside the header's own close button.
			expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
		});

		// Readable weeks later: the details are open without asking.
		it("opens the CLI's own message when the flow broke", async () => {
			server.setStatuses([
				{ agent: "claude", state: "signing_in", login_id: "claude-1" },
			]);
			server.setLatest(
				claudeWaiting({
					phase: "failed",
					failure: { reason: "flow_broken", detail: "no link within 30s" },
				}),
			);
			render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);

			expect(await screen.findByText("no link within 30s")).toBeVisible();
			expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute(
				"aria-expanded",
				"true",
			);
		});

		it("points a missing CLI at its install page", async () => {
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(
				codexWaiting({ phase: "failed", failure: { reason: "not_installed" } }),
			);
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);

			expect(
				await screen.findByRole("link", { name: /Install instructions/ }),
			).toHaveAttribute("href", expect.stringContaining("https://"));
		});

		it("names the outside credentials a sign-in ran into", async () => {
			server.setStatuses([
				{ agent: "claude", state: "signing_in", login_id: "claude-1" },
			]);
			server.setLatest(
				claudeWaiting({
					phase: "failed",
					failure: {
						reason: "external",
						external: { kind: "cloud_provider", provider: "bedrock" },
					},
				}),
			);
			render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);

			expect(
				await screen.findByRole("heading", {
					name: "Claude is managed outside Pockode",
				}),
			).toBeInTheDocument();
			expect(
				screen.getByText(
					"Using Amazon Bedrock. Change it on the server machine.",
				),
			).toBeInTheDocument();
		});

		it("starts a new sign-in of the same kind from Start again", async () => {
			const user = userEvent.setup();
			server.setStatuses([
				{ agent: "claude", state: "signing_in", login_id: "claude-1" },
			]);
			server.setLatest(
				claudeWaiting({
					account_kind: "console",
					phase: "failed",
					failure: { reason: "expired" },
				}),
			);
			server.actions.cliLoginStart.mockResolvedValue(
				claudeWaiting({ id: "claude-2", account_kind: "console" }),
			);
			render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);

			await user.click(
				await screen.findByRole("button", { name: "Start again" }),
			);

			expect(server.actions.cliLoginStart).toHaveBeenCalledWith(
				"claude",
				"console",
			);
			expect(
				await screen.findByRole("textbox", { name: "Sign-in code" }),
			).toBeInTheDocument();
		});
	});

	describe("copying", () => {
		it("copies the device code as the sign-in page opens", async () => {
			const user = userEvent.setup();
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(codexWaiting());
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);

			const link = await screen.findByRole("link", {
				name: /Open sign-in page/,
			});
			// jsdom would navigate; only the click's side effect is under test.
			link.addEventListener("click", (e) => e.preventDefault());
			await user.click(link);

			expect(writeText).toHaveBeenCalledWith("ABCD-12345");
			expect(await screen.findByText("Code copied")).toBeInTheDocument();
		});

		// Outside a secure context the browser has no clipboard at all.
		it("shows the whole link when copying it fails", async () => {
			const user = userEvent.setup();
			vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
			server.setStatuses([
				{ agent: "claude", state: "signing_in", login_id: "claude-1" },
			]);
			server.setLatest(claudeWaiting());
			render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);

			expect(
				await screen.findByText("claude.com/cai/oauth/authorize…"),
			).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Copy link" }));

			expect(await screen.findByText(CLAUDE_URL)).toBeInTheDocument();
		});
	});

	describe("following the server", () => {
		// The user was in the browser with the page in the background; the
		// sign-in finished there.
		it("shows a success that happened while it was closed", async () => {
			const user = userEvent.setup();
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(codexWaiting());
			const { unmount } = render(
				<CliLoginSheet agent="codex" onClose={vi.fn()} />,
			);
			await screen.findByText("ABCD-12345");
			await user.keyboard("{Escape}");
			unmount();

			server.setLatest(
				codexWaiting({
					revision: 2,
					phase: "succeeded",
					account: { email: "ada@example.com" },
				}),
			);
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);

			expect(
				await screen.findByRole("heading", { name: "Signed in to Codex" }),
			).toBeInTheDocument();
			expect(server.actions.cliLoginStart).not.toHaveBeenCalled();
		});

		it("moves on to a newer sign-in started elsewhere", async () => {
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(
				codexWaiting({ phase: "failed", failure: { reason: "expired" } }),
			);
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);
			await screen.findByRole("heading", { name: "This sign-in expired" });

			server.push(codexWaiting({ id: "codex-2", user_code: "WXYZ-67890" }));

			expect(await screen.findByText("WXYZ-67890")).toBeInTheDocument();
		});

		// A restarted server has no sign-in, and waiting on the old one would
		// spin forever.
		it("starts over when the server no longer has the sign-in", async () => {
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(codexWaiting());
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);
			await screen.findByText("ABCD-12345");

			server.setStatuses([{ agent: "codex", state: "signed_out" }]);
			server.actions.cliLoginStart.mockResolvedValue(
				codexWaiting({ id: "codex-2", user_code: "WXYZ-67890" }),
			);
			// What the subscription applies when a fresh subscribe answers null.
			act(() => cliLoginActions.applyLogin("codex", null));

			expect(await screen.findByText("WXYZ-67890")).toBeInTheDocument();
		});

		it("keeps showing how a sign-in ended after the server forgets it", async () => {
			server.setStatuses([
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			server.setLatest(
				codexWaiting({ phase: "failed", failure: { reason: "expired" } }),
			);
			render(<CliLoginSheet agent="codex" onClose={vi.fn()} />);
			await screen.findByRole("heading", { name: "This sign-in expired" });

			server.setStatuses([{ agent: "codex", state: "signed_out" }]);
			act(() => cliLoginActions.applyLogin("codex", null));

			expect(
				screen.getByRole("heading", { name: "This sign-in expired" }),
			).toBeInTheDocument();
			expect(server.actions.cliLoginStart).not.toHaveBeenCalled();
		});

		it("starts nothing when closed while switching account kind", async () => {
			const user = userEvent.setup();
			server.setStatuses([
				{ agent: "claude", state: "signing_in", login_id: "claude-1" },
			]);
			server.setLatest(claudeWaiting());
			let finishCancel: (login: CliLogin) => void = () => {};
			server.actions.cliLoginCancel.mockImplementation(
				() =>
					new Promise<CliLogin>((resolve) => {
						finishCancel = resolve;
					}),
			);
			const { unmount } = render(
				<CliLoginSheet agent="claude" onClose={vi.fn()} />,
			);
			await user.click(
				await screen.findByRole("button", {
					name: "Use an Anthropic Console account instead",
				}),
			);
			unmount();

			await act(async () =>
				finishCancel(claudeWaiting({ revision: 2, phase: "canceled" })),
			);

			expect(server.actions.cliLoginStart).not.toHaveBeenCalled();
		});
	});

	// The sheet navigates nowhere, so storage is the one place a secret could
	// outlive it.
	it("keeps the link and the pasted code out of storage", async () => {
		const user = userEvent.setup();
		server.setStatuses([
			{ agent: "claude", state: "signing_in", login_id: "claude-1" },
		]);
		server.setLatest(claudeWaiting());
		server.actions.cliLoginSubmitCode.mockResolvedValue(
			claudeWaiting({ revision: 2, phase: "verifying" }),
		);
		render(<CliLoginSheet agent="claude" onClose={vi.fn()} />);
		await user.type(
			await screen.findByRole("textbox", { name: "Sign-in code" }),
			"pasted-code#state",
		);
		await user.click(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() =>
			expect(useCliLoginStore.getState().logins.claude?.phase).toBe(
				"verifying",
			),
		);

		const stored =
			JSON.stringify({ ...localStorage }) +
			JSON.stringify({ ...sessionStorage });
		for (const secret of ["secret-state", "pasted-code"]) {
			expect(stored).not.toContain(secret);
		}
	});

	// The chat's way in: the failed turn's message comes back as a draft, and
	// never over one the user already has.
	describe("send again", () => {
		function signInFromChat(draftKept: boolean) {
			server.setStatuses([{ agent: "codex", state: "signed_out" }]);
			server.actions.cliLoginStart.mockResolvedValue(codexWaiting());
			const onSendAgain = vi.fn();
			render(
				<CliLoginSheet
					agent="codex"
					onClose={vi.fn()}
					sendAgain={{ text: "fix the build", draftKept, onSendAgain }}
				/>,
			);
			return onSendAgain;
		}

		async function finish() {
			await screen.findByText("ABCD-12345");
			server.push(codexWaiting({ revision: 2, phase: "succeeded" }));
			await screen.findByRole("heading", { name: "Signed in to Codex" });
		}

		it("puts the message back once signed in, and only then", async () => {
			const onSendAgain = signInFromChat(false);
			await screen.findByText("ABCD-12345");
			expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();

			await finish();
			await userEvent.click(screen.getByRole("button", { name: "Send again" }));
			expect(onSendAgain).toHaveBeenCalled();
		});

		it("offers the message for copying when the input already holds a draft", async () => {
			vi.stubGlobal("navigator", { clipboard: undefined });
			const onSendAgain = signInFromChat(true);
			await finish();

			expect(screen.getByText("Your draft was kept.")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
			await userEvent.click(
				screen.getByRole("button", { name: "Copy message" }),
			);
			// No clipboard: the message is shown in full to copy by hand.
			expect(await screen.findByText("fix the build")).toBeInTheDocument();
			expect(onSendAgain).not.toHaveBeenCalled();
		});

		// Signed in from a terminal, or from Settings, since the turn failed.
		it("is offered when the CLI turns out to be signed in already", async () => {
			server.setStatuses([{ agent: "codex", state: "signed_in" }]);
			render(
				<CliLoginSheet
					agent="codex"
					onClose={vi.fn()}
					sendAgain={{
						text: "fix the build",
						draftKept: false,
						onSendAgain: vi.fn(),
					}}
				/>,
			);

			expect(
				await screen.findByRole("button", { name: "Send again" }),
			).toBeInTheDocument();
		});
	});
});
