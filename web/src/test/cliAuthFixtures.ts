import { act } from "@testing-library/react";
import { vi } from "vitest";
import { useCliLoginStore } from "../lib/cliLoginStore";
import type {
	CliAuthStatus,
	CliLogin,
	CliLoginChangedNotification,
} from "../types/cliAuth";
import type {
	CliProfileChangedNotification,
	CliProfileInspection,
	CliProfileOverview,
} from "../types/cliProfile";
import type {
	CliUpdate,
	CliUpdateChangedNotification,
	CliUpdateCheck,
} from "../types/cliUpdate";
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

export function makeUpdate(overrides: Partial<CliUpdate> = {}): CliUpdate {
	return {
		id: "update-1",
		agent: "claude",
		kind: "update",
		revision: 1,
		phase: "running",
		from_version: "2.1.283",
		target_version: "2.1.290",
		binary_path: "/home/ada/.local/bin/claude",
		started_at: new Date().toISOString(),
		...overrides,
	};
}

export function resetCliLoginStore() {
	useCliLoginStore.setState({
		statuses: {},
		settledStatuses: {},
		reading: {},
		profiles: null,
		profilesError: null,
		inspections: {},
		settledInspections: {},
		inspecting: {},
		logins: {},
		loginErrors: {},
		startedHere: [],
		checks: {},
		checking: {},
		checkErrors: {},
		updates: {},
		updateErrors: {},
		updatesStartedHere: [],
		updatesSeenEnding: [],
	});
}

export function makeOverview(
	overrides: Partial<CliProfileOverview> = {},
): CliProfileOverview {
	return {
		available: true,
		clis: [
			{ agent: "claude", profiles: [] },
			{ agent: "codex", profiles: [] },
		],
		...overrides,
	};
}

/**
 * The `cli_auth.*`, `cli_profile.*` and `cli_update.*` side of wsStore's
 * actions, with a server behind it that answers from what the test set:
 * statuses for status reads, inspections for profile reads, checks for update
 * checks, a sign-in, update or profile list for subscribe snapshots, and
 * `push` / `pushUpdate` / `pushProfiles` for the notifications.
 */
export function createFakeCliAuth() {
	let statuses: CliAuthStatus[] = [];
	let checks: CliUpdateCheck[] = [];
	const latestUpdate: Partial<Record<AgentType, CliUpdate | null>> = {};
	const updateListeners = new Map<
		string,
		{
			agent: AgentType;
			callback: (params: CliUpdateChangedNotification) => void;
		}
	>();
	const latest: Partial<Record<AgentType, CliLogin>> = {};
	const listeners = new Map<
		string,
		{
			agent: AgentType;
			callback: (params: CliLoginChangedNotification) => void;
		}
	>();
	let nextId = 0;
	let overview = makeOverview();
	let inspections: CliProfileInspection[] = [];
	const profileListeners = new Map<
		string,
		(params: CliProfileChangedNotification) => void
	>();

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
		cliProfileSubscribe: vi.fn(
			async (callback: (params: CliProfileChangedNotification) => void) => {
				const id = `profile-sub-${++nextId}`;
				profileListeners.set(id, callback);
				return { id, initial: overview };
			},
		),
		cliProfileUnsubscribe: vi.fn(async (id: string) => {
			profileListeners.delete(id);
		}),
		cliProfileInspect: vi.fn(async (agent?: AgentType, profileId?: string) =>
			inspections.filter(
				(i) =>
					(!agent || i.status.agent === agent) &&
					(profileId === undefined ||
						(i.status.profile_id ?? "") === profileId),
			),
		),
		cliProfileAdd: vi.fn(),
		cliProfileRename: vi.fn(async () => {}),
		cliProfileSwitch: vi.fn(async () => {}),
		cliProfileRemove: vi.fn(
			async (_agent: AgentType, _profileId: string): Promise<void> => {},
		),
		cliUpdateCheck: vi.fn(async (agent?: AgentType) =>
			agent ? checks.filter((c) => c.agent === agent) : checks,
		),
		cliUpdateStart: vi.fn(),
		cliUpdateInstall: vi.fn(),
		cliUpdateDismiss: vi.fn(async (_updateId: string) => {}),
		cliUpdateSubscribe: vi.fn(
			async (
				agent: AgentType,
				callback: (params: CliUpdateChangedNotification) => void,
			) => {
				const id = `update-sub-${++nextId}`;
				updateListeners.set(id, { agent, callback });
				return { id, initial: latestUpdate[agent] ?? null };
			},
		),
		cliUpdateUnsubscribe: vi.fn(async (id: string) => {
			updateListeners.delete(id);
		}),
	};

	return {
		actions,
		setStatuses(next: CliAuthStatus[]) {
			statuses = next;
		},
		/** What `cli_profile.inspect` answers from, every profile of every CLI. */
		setInspections(next: CliProfileInspection[]) {
			inspections = next;
		},
		/** A `cli_profile.changed` notification. */
		pushProfiles(next: CliProfileOverview) {
			overview = next;
			act(() => {
				for (const [id, callback] of profileListeners) {
					callback({ id, profiles: next });
				}
			});
		},
		/** What a fresh profile subscribe answers with. */
		setOverview(next: CliProfileOverview) {
			overview = next;
		},
		setChecks(next: CliUpdateCheck[]) {
			checks = next;
		},
		/** What a fresh update subscribe answers with. */
		setLatestUpdate(agent: AgentType, update: CliUpdate | null) {
			latestUpdate[agent] = update;
		},
		/** A `cli_update.changed` notification. */
		pushUpdate(agent: AgentType, update: CliUpdate | null) {
			latestUpdate[agent] = update;
			act(() => {
				for (const [id, listener] of updateListeners) {
					if (listener.agent === agent) listener.callback({ id, update });
				}
			});
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
