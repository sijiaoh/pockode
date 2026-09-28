import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCliLoginStore } from "../../lib/cliLoginStore";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	resetCliLoginStore,
} from "../../test/cliAuthFixtures";
import type { AssistantMessage, ContentPart } from "../../types/message";
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
});

const claudeNotice: ContentPart = {
	type: "warning",
	message: "Not logged in · Please run /login",
	code: "authentication_failed",
	authFailure: "claude",
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
		authFailure: "claude",
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
		expect(onSignIn).toHaveBeenCalledWith("claude", "a1");
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
			type: "warning",
			message,
			code: "stream_error",
			authFailure: "codex",
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
