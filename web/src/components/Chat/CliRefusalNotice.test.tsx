import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCliLoginStore } from "../../lib/cliLoginStore";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeOverview,
	resetCliLoginStore,
} from "../../test/cliAuthFixtures";
import type { CliAuthStatus } from "../../types/cliAuth";
import type { AssistantMessage, ContentPart } from "../../types/message";
import type { AgentType } from "../../types/settings";
import MessageItem from "./MessageItem";

const ws = vi.hoisted(() => ({ actions: {} as Record<string, unknown> }));

vi.mock("../../lib/wsStore", () => {
	const state = () => ({ workDir: "/w", actions: ws.actions });
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
	server = createFakeCliAuth();
	ws.actions = server.actions;
	// What ChatPanel follows while a transcript holds a refusal.
	useCliLoginStore.setState({ profiles: makeOverview() });
});

const claudeNotice: ContentPart = {
	id: "warning-1",
	type: "warning",
	message: "Not logged in · Please run /login",
	code: "authentication_failed",
	authFailure: { agent: "claude" },
};

function failedTurn(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		id: "a1",
		role: "assistant",
		parts: [claudeNotice],
		status: "error",
		error: "Not logged in · Please run /login",
		authFailure: { agent: "claude" },
		createdAt: new Date(),
		...overrides,
	};
}

describe("an auth failure in the transcript", () => {
	it("draws the notice in place of the error line, once, with a way to sign in", async () => {
		server.setStatuses([{ agent: "claude", state: "signed_out" }]);
		const onSignIn = vi.fn();
		render(
			<MessageItem sessionId="s" message={failedTurn()} onSignIn={onSignIn} />,
		);

		// The CLI's own notice says the same thing, so it is not drawn beside it.
		expect(
			screen.getAllByText("Not logged in · Please run /login"),
		).toHaveLength(1);
		expect(
			screen.getByText("Claude couldn't authenticate when this turn ran."),
		).toBeInTheDocument();

		await userEvent.click(
			await screen.findByRole("button", { name: "Sign in to Claude" }),
		);
		expect(onSignIn).toHaveBeenCalledWith("claude", "a1", undefined);
	});

	// Whether there is anything to sign in to is live state, not the record's.
	it("offers no sign-in for credentials managed outside Pockode", async () => {
		server.setStatuses([
			{
				agent: "claude",
				state: "external",
				external: { kind: "api_key", source: "ANTHROPIC_API_KEY" },
			},
		]);
		render(
			<MessageItem sessionId="s" message={failedTurn()} onSignIn={vi.fn()} />,
		);

		expect(await screen.findByText("ANTHROPIC_API_KEY")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Sign in to Claude" }),
		).toBeNull();
	});

	it("reads live status once for every notice of one CLI", async () => {
		server.setStatuses([{ agent: "claude", state: "signed_out" }]);
		render(
			<>
				<MessageItem sessionId="s" message={failedTurn()} onSignIn={vi.fn()} />
				<MessageItem
					sessionId="s"
					message={failedTurn({ id: "a2" })}
					onSignIn={vi.fn()}
				/>
			</>,
		);

		expect(
			await screen.findAllByRole("button", { name: "Sign in to Claude" }),
		).toHaveLength(2);
		expect(server.actions.cliAuthStatus).toHaveBeenCalledTimes(1);
		expect(useCliLoginStore.getState().statuses.claude?.state).toBe(
			"signed_out",
		);
	});

	// The CLI retries a refused key for minutes; the notice does not wait.
	it("draws the notice on the latest refused retry while the turn runs", () => {
		const retry = (message: string): ContentPart => ({
			id: message,
			type: "warning",
			message,
			code: "stream_error",
			authFailure: { agent: "codex" },
		});
		render(
			<MessageItem
				sessionId="s"
				message={failedTurn({
					parts: [retry("401 first"), retry("401 second")],
					status: "streaming",
					error: undefined,
					authFailure: undefined,
				})}
				isOpenTurn
				onSignIn={vi.fn()}
			/>,
		);

		expect(screen.getAllByText(/couldn't authenticate/)).toHaveLength(1);
		expect(screen.getByText("401 second")).toBeInTheDocument();
		expect(screen.getByText("401 first")).toBeInTheDocument();
	});

	it("keeps an unmarked error as the error line, with no sign-in", () => {
		render(
			<MessageItem
				sessionId="s"
				message={failedTurn({
					parts: [],
					error: "API Error: 529 Overloaded",
					authFailure: undefined,
				})}
				onSignIn={vi.fn()}
			/>,
		);

		expect(screen.getByText("API Error: 529 Overloaded")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't authenticate/)).toBeNull();
		expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();
	});
});

const WORK = "p-work";
const SPARE = "p-spare";

/** Claude with Work and Spare stored, `current` chosen. */
function accounts(current: string, over = {}) {
	useCliLoginStore.setState({
		profiles: makeOverview({
			clis: [
				{
					agent: "claude",
					...(current ? { current_profile_id: current } : {}),
					profiles: [
						{ id: WORK, name: "Work" },
						{ id: SPARE, name: "Spare" },
					],
				},
				{ agent: "codex", profiles: [] },
			],
			...over,
		}),
	});
}

function inspect(
	id: string,
	rest: Omit<CliAuthStatus, "agent" | "profile_id">,
): { status: CliAuthStatus } {
	return {
		status: { agent: "claude", ...(id ? { profile_id: id } : {}), ...rest },
	};
}

function signedInEverywhere(
	over: Partial<Record<string, CliAuthStatus["state"]>> = {},
) {
	server.setInspections(
		["", WORK, SPARE].map((id) =>
			inspect(id, { state: over[id] ?? "signed_in" }),
		),
	);
}

const usageWarning = (profileId?: string): ContentPart => ({
	id: "limit",
	type: "warning",
	message: "You've hit your limit · resets 5pm",
	code: "rate_limit",
	usageLimit: {
		agent: "claude",
		...(profileId !== undefined ? { profileId } : {}),
	},
});

/** Claude's usage limit: a marked warning, then an unmarked failed ending. */
function limitedTurn(profileId?: string): AssistantMessage {
	return failedTurn({
		parts: [usageWarning(profileId)],
		error: "Claude Code process exited with code 1",
		authFailure: undefined,
	});
}

describe("a refusal on a CLI with several accounts", () => {
	it("names the record's account and offers both ways out", async () => {
		const user = userEvent.setup();
		accounts(WORK);
		signedInEverywhere({ [WORK]: "signed_out" });
		const onSignIn = vi.fn();
		const onSwitchAccount = vi.fn();
		const message = failedTurn({
			authFailure: { agent: "claude", profileId: WORK },
		});
		render(
			<MessageItem
				sessionId="s"
				message={message}
				onSignIn={onSignIn}
				onSwitchAccount={onSwitchAccount}
			/>,
		);

		expect(
			screen.getByText(
				"Claude couldn't authenticate as Work when this turn ran.",
			),
		).toBeInTheDocument();
		await user.click(
			await screen.findByRole("button", { name: "Sign in to Claude" }),
		);
		expect(onSignIn).toHaveBeenCalledWith("claude", "a1", {
			id: WORK,
			name: "Work",
		});
		await user.click(screen.getByRole("button", { name: "Switch account" }));
		expect(onSwitchAccount).toHaveBeenCalledWith(
			{ kind: "auth", agent: "claude", profileId: WORK },
			"a1",
		);
	});

	// Events are events: the sentence is the record's account, never the
	// current one.
	it("names the record's account even after another became current", async () => {
		accounts(SPARE);
		signedInEverywhere();
		render(
			<MessageItem
				sessionId="s"
				message={failedTurn({
					authFailure: { agent: "claude", profileId: "" },
				})}
				onSwitchAccount={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(
				"Claude couldn't authenticate as Default when this turn ran.",
			),
		).toBeInTheDocument();
	});

	it("says a removed account, and signs the current one in", async () => {
		const user = userEvent.setup();
		accounts(SPARE);
		signedInEverywhere({ [SPARE]: "signed_out" });
		const onSignIn = vi.fn();
		render(
			<MessageItem
				sessionId="s"
				message={failedTurn({
					authFailure: { agent: "claude", profileId: "p-gone" },
				})}
				onSignIn={onSignIn}
			/>,
		);

		expect(
			screen.getByText(
				"Claude couldn't authenticate as a removed account when this turn ran.",
			),
		).toBeInTheDocument();
		await user.click(
			await screen.findByRole("button", { name: "Sign in to Claude" }),
		);
		expect(onSignIn).toHaveBeenCalledWith("claude", "a1", {
			id: SPARE,
			name: "Spare",
		});
	});

	it("names no account for a record kept before accounts were", () => {
		accounts(WORK);
		render(<MessageItem sessionId="s" message={failedTurn()} />);

		expect(
			screen.getByText("Claude couldn't authenticate when this turn ran."),
		).toBeInTheDocument();
	});

	it("words a usage limit without claiming the limit was hit, and keeps the unmarked ending", async () => {
		const user = userEvent.setup();
		accounts(WORK);
		signedInEverywhere();
		const onSwitchAccount = vi.fn();
		render(
			<MessageItem
				sessionId="s"
				message={limitedTurn(WORK)}
				onSignIn={vi.fn()}
				onSwitchAccount={onSwitchAccount}
			/>,
		);

		expect(
			screen.getByText(
				/Claude's requests as Work were turned away for rate limits when this turn ran\./,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/hit its usage limit/)).toBeNull();
		// The ending is unmarked: hiding it could hide another failure.
		expect(
			screen.getByText("Claude Code process exited with code 1"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Sign in to Claude" }),
		).toBeNull();
		await user.click(
			await screen.findByRole("button", { name: "Switch account" }),
		);
		expect(onSwitchAccount).toHaveBeenCalledWith(
			{ kind: "usage_limit", agent: "claude", profileId: WORK },
			"a1",
		);
		expect(
			screen.getByText(
				/If it's the account's usage limit, switch to another account and send again\./,
			),
		).toBeInTheDocument();
	});

	it("offers no switch when every account uses the same outside credentials", async () => {
		accounts(WORK);
		const external = {
			state: "external" as const,
			external: { kind: "api_key" as const, source: "ANTHROPIC_API_KEY" },
		};
		server.setInspections(["", WORK, SPARE].map((id) => inspect(id, external)));
		render(
			<MessageItem
				sessionId="s"
				message={limitedTurn(WORK)}
				onSwitchAccount={vi.fn()}
			/>,
		);

		expect(
			await screen.findByText(/Every Claude account uses/),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();
	});

	it("stays the plain warning where this machine can't use accounts", async () => {
		accounts(WORK, { available: false });
		signedInEverywhere();
		render(
			<MessageItem
				sessionId="s"
				message={limitedTurn("")}
				onSwitchAccount={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("You've hit your limit · resets 5pm"),
		).toBeInTheDocument();
		expect(screen.queryByText(/turned away/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();
		expect(server.actions.cliProfileInspect).not.toHaveBeenCalled();
	});
});

describe("before and without the account list", () => {
	// A sign-in is aimed at an account, which only the list says.
	it("offers no sign-in until the list has arrived", async () => {
		useCliLoginStore.setState({ profiles: null });
		server.setStatuses([{ agent: "claude", state: "signed_out" }]);
		render(
			<MessageItem sessionId="s" message={failedTurn()} onSignIn={vi.fn()} />,
		);

		expect(
			screen.getByText("Claude couldn't authenticate when this turn ran."),
		).toBeInTheDocument();
		expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("button", { name: "Sign in to Claude" }),
		).toBeNull();

		useCliLoginStore.setState({ profiles: makeOverview() });
		expect(
			await screen.findByRole("button", { name: "Sign in to Claude" }),
		).toBeInTheDocument();
	});

	it("reads as one account when the list could not be had", async () => {
		useCliLoginStore.setState({ profiles: null, profilesError: "boom" });
		server.setStatuses([{ agent: "claude", state: "signed_out" }]);
		const onSignIn = vi.fn();
		render(
			<MessageItem sessionId="s" message={failedTurn()} onSignIn={onSignIn} />,
		);

		await userEvent.click(
			await screen.findByRole("button", { name: "Sign in to Claude" }),
		);
		expect(onSignIn).toHaveBeenCalledWith("claude", "a1", undefined);
	});
});

describe("a refusal whose accounts have changed since", () => {
	it("still says a named account was removed once no stored account is left", () => {
		render(
			<MessageItem
				sessionId="s"
				message={failedTurn({
					authFailure: { agent: "claude", profileId: WORK },
				})}
			/>,
		);

		expect(
			screen.getByText(
				"Claude couldn't authenticate as a removed account when this turn ran.",
			),
		).toBeInTheDocument();
	});

	// Sessions run as Default there, so signing Work in fixes nothing.
	it("opens today's sign-in where this machine can't use other accounts", async () => {
		const user = userEvent.setup();
		accounts(WORK, { available: false });
		signedInEverywhere({ "": "signed_out", [WORK]: "signed_out" });
		const onSignIn = vi.fn();
		render(
			<MessageItem
				sessionId="s"
				message={failedTurn({
					authFailure: { agent: "claude", profileId: WORK },
				})}
				onSignIn={onSignIn}
			/>,
		);

		await user.click(
			await screen.findByRole("button", { name: "Sign in to Claude" }),
		);
		expect(onSignIn).toHaveBeenCalledWith("claude", "a1", undefined);
	});

	// One account's read is enough to know switching is worth offering.
	it("offers the switch without waiting for a slow account's read", async () => {
		accounts(WORK);
		signedInEverywhere();
		const read = server.actions.cliProfileInspect.getMockImplementation();
		server.actions.cliProfileInspect.mockImplementation(
			async (agent?: AgentType, profileId?: string) =>
				profileId === SPARE
					? new Promise(() => {})
					: (read?.(agent, profileId) ?? []),
		);
		render(
			<MessageItem
				sessionId="s"
				message={limitedTurn(WORK)}
				onSwitchAccount={vi.fn()}
			/>,
		);

		expect(
			await screen.findByRole("button", { name: "Switch account" }),
		).toBeInTheDocument();
	});
});

describe("a usage limit on a CLI with one account", () => {
	it("stays the plain warning it always was", () => {
		render(
			<MessageItem
				sessionId="s"
				message={limitedTurn("")}
				onSignIn={vi.fn()}
				onSwitchAccount={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("You've hit your limit · resets 5pm"),
		).toBeInTheDocument();
		expect(screen.queryByText(/turned away/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Switch account" })).toBeNull();
	});
});
