import { act } from "@testing-library/react";
import { vi } from "vitest";
import { useCliLoginStore } from "../lib/cliLoginStore";
import type {
	CliAuthStatus,
	CliLogin,
	CliLoginChangedNotification,
} from "../types/cliAuth";
import type { AgentType } from "../types/settings";

export function makeLogin(overrides: Partial<CliLogin> = {}): CliLogin {
	return {
		id: "login-1",
		agent: "codex",
		revision: 1,
		phase: "waiting",
		started_at: "2026-09-28T10:00:00Z",
		expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
		...overrides,
	};
}

export function resetCliLoginStore() {
	useCliLoginStore.setState({
		statuses: {},
		reading: {},
		logins: {},
		loginErrors: {},
		startedHere: [],
	});
}

/**
 * The `cli_auth.*` side of wsStore's actions, with a server behind it that
 * answers from what the test set: statuses for status reads, a sign-in for
 * subscribe snapshots, and `push` for the notifications a running sign-in sends.
 */
export function createFakeCliAuth() {
	let statuses: CliAuthStatus[] = [];
	const latest: Partial<Record<AgentType, CliLogin>> = {};
	const listeners = new Map<
		string,
		{
			agent: AgentType;
			callback: (params: CliLoginChangedNotification) => void;
		}
	>();
	let nextId = 0;

	const actions = {
		cliAuthStatus: vi.fn(async (agent?: AgentType) =>
			agent ? statuses.filter((s) => s.agent === agent) : statuses,
		),
		cliAuthLogout: vi.fn(),
		cliLoginStart: vi.fn(),
		cliLoginSubmitCode: vi.fn(),
		cliLoginCancel: vi.fn(),
		cliLoginSubscribe: vi.fn(
			async (
				agent: AgentType,
				callback: (params: CliLoginChangedNotification) => void,
			) => {
				const id = `sub-${++nextId}`;
				listeners.set(id, { agent, callback });
				return { id, initial: latest[agent] ?? null };
			},
		),
		cliLoginUnsubscribe: vi.fn(async (id: string) => {
			listeners.delete(id);
		}),
	};

	return {
		actions,
		setStatuses(next: CliAuthStatus[]) {
			statuses = next;
		},
		/** What a fresh subscribe answers with. */
		setLatest(login: CliLogin) {
			latest[login.agent] = login;
		},
		/** A `cli_auth.login.changed` notification. */
		push(login: CliLogin) {
			latest[login.agent] = login;
			act(() => {
				for (const [id, listener] of listeners) {
					if (listener.agent === login.agent) listener.callback({ id, login });
				}
			});
		},
	};
}

export type FakeCliAuth = ReturnType<typeof createFakeCliAuth>;
