import { create } from "zustand";
import type {
	CliAccountKind,
	CliAuthStatus,
	CliLogin,
	CliLoginPhase,
} from "../types/cliAuth";
import type { CliUpdate, CliUpdateCheck } from "../types/cliUpdate";
import type { AgentType } from "../types/settings";
import { errorMessage } from "../utils/errorMessage";
import { AGENT_TYPES } from "./agentType";
import { cliInstallRefusedReason } from "./rpc";
import { useWSStore } from "./wsStore";

interface CliLoginState {
	/**
	 * The last status read per CLI. Absent until the first read has answered: a
	 * status is never guessed, and a failed read is `unavailable`, never
	 * `signed_out` (docs/cli-login-ui.md, "The card states").
	 */
	statuses: Partial<Record<AgentType, CliAuthStatus>>;
	/**
	 * The last status the server answered that was not `updating`. While an
	 * update runs the server does not run the CLI, so the card keeps showing
	 * what it read before (docs/cli-update-ui.md, "While it runs").
	 */
	settledStatuses: Partial<Record<AgentType, CliAuthStatus>>;
	/** CLIs with a status read in flight. */
	reading: Partial<Record<AgentType, boolean>>;
	/** The latest sign-in per CLI, as the server last reported it. */
	logins: Partial<Record<AgentType, CliLogin>>;
	/**
	 * Why the CLI's sign-in could not be followed, when subscribing to it
	 * failed. Cleared by the next copy of the sign-in to arrive.
	 */
	loginErrors: Partial<Record<AgentType, string>>;
	/**
	 * Sign-ins this page started. Everything else running was "started earlier"
	 * — after a reload the same phone is a new page, and nothing tells it apart
	 * from a second device.
	 */
	startedHere: string[];

	/** The last update check per CLI. Absent until one has answered. */
	checks: Partial<Record<AgentType, CliUpdateCheck>>;
	/** CLIs with a check in flight. */
	checking: Partial<Record<AgentType, boolean>>;
	/** Why the last check request failed; cleared by the next check to answer. */
	checkErrors: Partial<Record<AgentType, string>>;
	/** The latest update or install per CLI, as the server last reported it. */
	updates: Partial<Record<AgentType, CliUpdate>>;
	/** Why the CLI's update could not be followed, as `loginErrors`. */
	updateErrors: Partial<Record<AgentType, string>>;
	/** Updates and installs this page started, as `startedHere` for sign-ins. */
	updatesStartedHere: string[];
	/**
	 * Updates this page saw running and then saw end. Only these are shown as
	 * "Updated": a success that ended unseen was confirmed on the screen that
	 * watched it. Forgotten when the user leaves Settings.
	 */
	updatesSeenEnding: string[];
}

/**
 * Sign-in status and flows, and version checks and updates, for the AI CLIs on
 * the server machine — one store because the card's states read both halves: a
 * running update holds the sign-in still, and a running sign-in holds the
 * update off.
 *
 * A store because a sign-in outlives every component that shows it: the user
 * closes the sheet and leaves for a browser, and the card, the sheet reopened
 * later and the chat's way in all have to find the same flow. In memory only —
 * the link and the codes in a `CliLogin` are secrets and must not reach storage.
 */
export const useCliLoginStore = create<CliLoginState>(() => ({
	statuses: {},
	settledStatuses: {},
	reading: {},
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
}));

const ENDED: readonly CliLoginPhase[] = ["succeeded", "failed", "canceled"];

export function isLoginEnded(login: CliLogin): boolean {
	return ENDED.includes(login.phase);
}

function actions() {
	return useWSStore.getState().actions;
}

type ReadKind = "reading" | "checking";

// Per kind and per CLI, so that only the newest read lands: a refresh started
// after a sign-out must not be overwritten by one started before it, nor a
// check that saw an update running by one that saw it end.
const generations: Record<ReadKind, Partial<Record<AgentType, number>>> = {
	reading: {},
	checking: {},
};

function setInFlight(
	kind: ReadKind,
	agents: readonly AgentType[],
	inFlight: boolean,
) {
	useCliLoginStore.setState((s) => {
		const next = { ...s[kind] };
		for (const agent of agents) next[agent] = inFlight;
		return { [kind]: next };
	});
}

/** Supersedes any read of `kind` in flight for `agents`, which may not land. */
function supersede(kind: ReadKind, agents: readonly AgentType[]) {
	for (const a of agents)
		generations[kind][a] = (generations[kind][a] ?? 0) + 1;
}

/**
 * Starts a read of `kind` for `agents`. `isCurrent` says whether an agent's
 * answer may still land; `end` marks the read over for those it still owns.
 */
function beginRead(kind: ReadKind, agents: readonly AgentType[]) {
	supersede(kind, agents);
	const mine = new Map(agents.map((a) => [a, generations[kind][a]]));
	const isCurrent = (a: AgentType) => generations[kind][a] === mine.get(a);
	setInFlight(kind, agents, true);
	return {
		isCurrent,
		end: () => setInFlight(kind, agents.filter(isCurrent), false),
	};
}

/**
 * `requestFailed` marks a status made up for a request that failed: it is
 * about the request, not the sign-in, so it is not one the card can hold.
 */
function setStatus(status: CliAuthStatus, requestFailed = false) {
	useCliLoginStore.setState((s) => ({
		statuses: { ...s.statuses, [status.agent]: status },
		...(status.state === "updating" || requestFailed
			? {}
			: {
					settledStatuses: { ...s.settledStatuses, [status.agent]: status },
				}),
	}));
}

function isUpdateEnded(update: CliUpdate): boolean {
	return update.phase !== "running";
}

/**
 * What an update's ending sets off. `watched`: this page followed it running,
 * or started it — only such a success is drawn as "Updated".
 */
function afterUpdateEnded(
	agent: AgentType,
	update: CliUpdate,
	watched: boolean,
) {
	const { checks, statuses, checking, reading, updatesSeenEnding } =
		useCliLoginStore.getState();
	const seenEnding = watched && !updatesSeenEnding.includes(update.id);
	if (seenEnding) {
		useCliLoginStore.setState((s) => ({
			updatesSeenEnding: [...s.updatesSeenEnding, update.id],
		}));
	}

	// The version and the sign-in are read again once the CLI is no longer
	// being replaced: an update ending changes the one and lets the other be
	// read, and one on screen from while it ran is stale. A read still out is
	// superseded when this page saw the ending; otherwise it is left to land,
	// and `staleAgents` catches it if it was answered while the update ran.
	if (seenEnding || (isStaleRead(checks[agent], update) && !checking[agent])) {
		void cliLoginActions.refreshCheck(agent);
	}
	if (seenEnding || (isStaleRead(statuses[agent], update) && !reading[agent])) {
		void cliLoginActions.refreshStatus(agent);
	}
}

/**
 * A read answered `updating` — or, for a check, `installing` — for an update
 * known to have ended since.
 */
function isStaleRead(
	read: { state: string; update_id?: string } | undefined,
	ended: CliUpdate | undefined,
): boolean {
	return (
		(read?.state === "updating" || read?.state === "installing") &&
		!!ended &&
		ended.id === read.update_id &&
		isUpdateEnded(ended)
	);
}

// Updates a stale read was retried for, per kind: once each, so a server that
// kept answering `updating` for an ended update could not keep the page reading.
// Module state that outlives resetCliLoginStore: a test of the stale path uses
// an update id of its own.
const staleRetries: Record<ReadKind, Set<string>> = {
	reading: new Set(),
	checking: new Set(),
};

/**
 * The agents whose read just landed stale — answered while an update ran,
 * landing after it ended, too late for the ending's own re-read — to read once
 * more.
 */
function staleAgents(
	kind: ReadKind,
	reads: readonly { agent: AgentType; state: string; update_id?: string }[],
	landed: (agent: AgentType) => boolean,
): AgentType[] {
	const { updates } = useCliLoginStore.getState();
	return reads
		.filter((r) => {
			const update = updates[r.agent];
			if (!update || !landed(r.agent) || !isStaleRead(r, update)) return false;
			if (staleRetries[kind].has(update.id)) return false;
			staleRetries[kind].add(update.id);
			return true;
		})
		.map((r) => r.agent);
}

/** Takes the reply to a start or install as an update this page started. */
function followStarted(agent: AgentType, update: CliUpdate) {
	useCliLoginStore.setState((s) => ({
		updatesStartedHere: s.updatesStartedHere.includes(update.id)
			? s.updatesStartedHere
			: [...s.updatesStartedHere, update.id],
	}));
	cliLoginActions.applyUpdate(agent, update);
	// An update over before its start's reply came back ended with nothing
	// running on this page to see, and the reply lost to the ended copy.
	const stored = useCliLoginStore.getState().updates[agent];
	if (stored?.id === update.id && isUpdateEnded(stored)) {
		afterUpdateEnded(agent, stored, true);
	}
}

export const cliLoginActions = {
	/**
	 * Reads status afresh for `agent`, or for every CLI, and resolves to what it
	 * read — which the store holds too unless a newer read overtook it. Never
	 * rejects: a failed request is `unavailable` with its reason, which is how
	 * the card says it could not tell.
	 */
	refreshStatus: async (agent?: AgentType): Promise<CliAuthStatus[]> => {
		const agents = agent ? [agent] : AGENT_TYPES;
		const { isCurrent, end } = beginRead("reading", agents);
		let statuses: CliAuthStatus[];
		let requestFailed = false;
		try {
			statuses = await actions().cliAuthStatus(agent);
		} catch (err) {
			const error = errorMessage(err);
			statuses = agents.map((a) => ({ agent: a, state: "unavailable", error }));
			requestFailed = true;
		}
		for (const status of statuses) {
			if (isCurrent(status.agent)) setStatus(status, requestFailed);
		}
		const stale = staleAgents("reading", statuses, isCurrent);
		end();
		for (const a of stale) void cliLoginActions.refreshStatus(a);
		return statuses;
	},

	/**
	 * Reads status for `agent` unless it has been read or is being read — for
	 * the many surfaces that only need *a* status, where a read each would
	 * spawn a CLI each on the server. A read that failed counts as none, so the
	 * next surface to ask tries again rather than living with the failure; so
	 * does `updating`, which outside Settings nothing follows to its end, and
	 * which the server answers without running the CLI.
	 */
	ensureStatus: (agent: AgentType): void => {
		const { statuses, reading } = useCliLoginStore.getState();
		if (reading[agent]) return;
		const state = statuses[agent]?.state;
		if (state && state !== "unavailable" && state !== "updating") return;
		void cliLoginActions.refreshStatus(agent);
	},

	/**
	 * Takes a copy of the CLI's sign-in. Replies and notifications can arrive in
	 * either order, so of two copies of one sign-in the higher revision wins.
	 *
	 * @param current Whether the copy is the CLI's current sign-in — a
	 * subscribe snapshot, a notification, a start's reply — which replaces a
	 * different one whatever the revisions say (they restart with the server).
	 * A reply to `submit_code` or `cancel` is only about the sign-in it names,
	 * which may be an old one: it must not displace a newer sign-in.
	 */
	applyLogin: (
		agent: AgentType,
		login: CliLogin | null,
		current = true,
	): void => {
		const previous = useCliLoginStore.getState().logins[agent];
		if (login && previous?.id === login.id) {
			if (previous.revision > login.revision) return;
		} else if (!current && previous) {
			return;
		}
		useCliLoginStore.setState((s) => {
			const logins = { ...s.logins };
			if (login) logins[agent] = login;
			else delete logins[agent];
			const loginErrors = { ...s.loginErrors };
			delete loginErrors[agent];
			return { logins, loginErrors };
		});

		// A sign-in the status on screen predates — started on another screen
		// after it was read. Cheap: a running sign-in is answered without the CLI.
		const { statuses, reading } = useCliLoginStore.getState();
		const status = statuses[agent];
		if (
			login &&
			!isLoginEnded(login) &&
			status &&
			status.login_id !== login.id &&
			!reading[agent]
		) {
			void cliLoginActions.refreshStatus(agent);
		}

		// A sign-in ending changes the CLI's status, and status is read, never
		// taken from the sign-in: its `account` is what happened then. Only an
		// ending seen happen: one already over when first seen was over before
		// the status on screen was read.
		if (
			login &&
			isLoginEnded(login) &&
			previous?.id === login.id &&
			!isLoginEnded(previous)
		) {
			void cliLoginActions.refreshStatus(agent);
		}
	},

	setLoginError: (agent: AgentType, error: string): void => {
		useCliLoginStore.setState((s) => ({
			loginErrors: { ...s.loginErrors, [agent]: error },
		}));
	},

	/**
	 * Starts a sign-in, or joins the one already running (the server returns
	 * it). Rejects when the server refused to start one.
	 */
	startLogin: async (
		agent: AgentType,
		accountKind?: CliAccountKind,
	): Promise<CliLogin> => {
		const login = await actions().cliLoginStart(agent, accountKind);
		useCliLoginStore.setState((s) => ({
			startedHere: s.startedHere.includes(login.id)
				? s.startedHere
				: [...s.startedHere, login.id],
		}));
		cliLoginActions.applyLogin(agent, login);
		return login;
	},

	submitCode: async (agent: AgentType, loginId: string, code: string) => {
		cliLoginActions.applyLogin(
			agent,
			await actions().cliLoginSubmitCode(loginId, code),
			false,
		);
	},

	cancelLogin: async (agent: AgentType, loginId: string) => {
		cliLoginActions.applyLogin(
			agent,
			await actions().cliLoginCancel(loginId),
			false,
		);
	},

	/**
	 * Checks afresh whether `agent`, or every CLI, has a newer release. Never
	 * rejects: a failed request leaves the last check in place and says why in
	 * `checkErrors` — never an "up to date" nobody read.
	 */
	refreshCheck: async (agent?: AgentType): Promise<void> => {
		const agents = agent ? [agent] : AGENT_TYPES;
		const { isCurrent, end } = beginRead("checking", agents);
		let stale: AgentType[] = [];
		try {
			const checks = await actions().cliUpdateCheck(agent);
			stale = staleAgents("checking", checks, isCurrent);
			useCliLoginStore.setState((s) => {
				const next = { ...s.checks };
				const errors = { ...s.checkErrors };
				for (const check of checks) {
					if (!isCurrent(check.agent)) continue;
					next[check.agent] = check;
					delete errors[check.agent];
				}
				return { checks: next, checkErrors: errors };
			});
		} catch (err) {
			const error = errorMessage(err);
			useCliLoginStore.setState((s) => {
				const errors = { ...s.checkErrors };
				for (const a of agents) if (isCurrent(a)) errors[a] = error;
				return { checkErrors: errors };
			});
		}
		end();
		for (const a of stale) void cliLoginActions.refreshCheck(a);
	},

	/**
	 * Takes a copy of the CLI's update, by the rule `applyLogin` follows: of
	 * two copies of one update the higher revision wins, and a current copy (a
	 * snapshot, a notification, a start's reply) replaces a different one.
	 */
	applyUpdate: (agent: AgentType, update: CliUpdate | null): void => {
		const previous = useCliLoginStore.getState().updates[agent];
		if (update && previous?.id === update.id) {
			if (previous.revision > update.revision) return;
		}
		useCliLoginStore.setState((s) => {
			const updates = { ...s.updates };
			if (update) updates[agent] = update;
			else delete updates[agent];
			const updateErrors = { ...s.updateErrors };
			delete updateErrors[agent];
			return { updates, updateErrors };
		});
		if (!update || !isUpdateEnded(update)) return;
		afterUpdateEnded(
			agent,
			update,
			previous?.id === update.id && !isUpdateEnded(previous),
		);
	},

	setUpdateError: (agent: AgentType, error: string): void => {
		useCliLoginStore.setState((s) => ({
			updateErrors: { ...s.updateErrors, [agent]: error },
		}));
	},

	/**
	 * Starts an update, or joins the one already running. Rejects with the
	 * server's reason when it refused — a refused start leaves no record.
	 */
	startUpdate: async (agent: AgentType): Promise<void> => {
		followStarted(agent, await actions().cliUpdateStart(agent));
	},

	/**
	 * Starts an install of a CLI the server does not have, or joins the one
	 * already running; it is followed as an update is. Rejects when the server
	 * refused, which `cliInstallRefusedReason` tells apart.
	 */
	startInstall: async (agent: AgentType): Promise<void> => {
		let install: CliUpdate;
		try {
			install = await actions().cliUpdateInstall(agent);
		} catch (err) {
			// The CLI is there after all — installed by hand since the card read
			// `not_installed` — so what is on screen is stale.
			if (cliInstallRefusedReason(err) === "already_installed") {
				void cliLoginActions.refreshCheck(agent);
				void cliLoginActions.refreshStatus(agent);
			}
			throw err;
		}
		followStarted(agent, install);
	},

	/** Drops an ended update for every client. Rejects when the server refused. */
	dismissUpdate: async (agent: AgentType, updateId: string): Promise<void> => {
		await actions().cliUpdateDismiss(updateId);
		// The notification says the same; this is for the reply that beats it.
		if (useCliLoginStore.getState().updates[agent]?.id === updateId) {
			cliLoginActions.applyUpdate(agent, null);
		}
	},

	/** The user has left Settings, where an "Updated" was shown. */
	forgetSeenUpdates: (): void => {
		useCliLoginStore.setState({ updatesSeenEnding: [] });
	},

	/** Rejects with the server's reason when the sign-out failed. */
	logout: async (agent: AgentType): Promise<void> => {
		const status = await actions().cliAuthLogout(agent);
		// Newer than any read still in flight, which must not land over it.
		supersede("reading", [agent]);
		setInFlight("reading", [agent], false);
		setStatus(status);
	},
};
