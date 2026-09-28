import { create } from "zustand";
import type {
	CliAccountKind,
	CliAuthStatus,
	CliLogin,
	CliLoginPhase,
} from "../types/cliAuth";
import type { AgentType } from "../types/settings";
import { errorMessage } from "../utils/errorMessage";
import { AGENT_TYPES } from "./agentType";
import { useWSStore } from "./wsStore";

interface CliLoginState {
	/**
	 * The last status read per CLI. Absent until the first read has answered: a
	 * status is never guessed, and a failed read is `unavailable`, never
	 * `signed_out` (docs/cli-login-ui.md, "The card states").
	 */
	statuses: Partial<Record<AgentType, CliAuthStatus>>;
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
}

/**
 * Sign-in status and flows for the AI CLIs on the server machine.
 *
 * A store because a sign-in outlives every component that shows it: the user
 * closes the sheet and leaves for a browser, and the card, the sheet reopened
 * later and the chat's way in all have to find the same flow. In memory only —
 * the link and the codes in a `CliLogin` are secrets and must not reach storage.
 */
export const useCliLoginStore = create<CliLoginState>(() => ({
	statuses: {},
	reading: {},
	logins: {},
	loginErrors: {},
	startedHere: [],
}));

const ENDED: readonly CliLoginPhase[] = ["succeeded", "failed", "canceled"];

export function isLoginEnded(login: CliLogin): boolean {
	return ENDED.includes(login.phase);
}

function actions() {
	return useWSStore.getState().actions;
}

// Per CLI, so that only the newest read lands: a refresh started after a
// sign-out must not be overwritten by one started before it.
const readGenerations: Partial<Record<AgentType, number>> = {};

function setStatus(status: CliAuthStatus) {
	useCliLoginStore.setState((s) => ({
		statuses: { ...s.statuses, [status.agent]: status },
	}));
}

function setReading(agents: readonly AgentType[], reading: boolean) {
	useCliLoginStore.setState((s) => {
		const next = { ...s.reading };
		for (const agent of agents) next[agent] = reading;
		return { reading: next };
	});
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
		const generations = new Map<AgentType, number>();
		for (const a of agents) {
			const generation = (readGenerations[a] ?? 0) + 1;
			readGenerations[a] = generation;
			generations.set(a, generation);
		}
		const isCurrent = (a: AgentType) =>
			readGenerations[a] === generations.get(a);

		setReading(agents, true);
		let statuses: CliAuthStatus[];
		try {
			statuses = await actions().cliAuthStatus(agent);
		} catch (err) {
			const error = errorMessage(err);
			statuses = agents.map((a) => ({ agent: a, state: "unavailable", error }));
		}
		for (const status of statuses) {
			if (isCurrent(status.agent)) setStatus(status);
		}
		setReading(agents.filter(isCurrent), false);
		return statuses;
	},

	/**
	 * Reads status for `agent` unless it has been read or is being read — for
	 * the many surfaces that only need *a* status, where a read each would
	 * spawn a CLI each on the server. A read that failed counts as none, so the
	 * next surface to ask tries again rather than living with the failure.
	 */
	ensureStatus: (agent: AgentType): void => {
		const { statuses, reading } = useCliLoginStore.getState();
		if (reading[agent]) return;
		if (statuses[agent] && statuses[agent].state !== "unavailable") return;
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

	/** Rejects with the server's reason when the sign-out failed. */
	logout: async (agent: AgentType): Promise<void> => {
		const status = await actions().cliAuthLogout(agent);
		// Newer than any read still in flight, which must not land over it.
		readGenerations[agent] = (readGenerations[agent] ?? 0) + 1;
		setReading([agent], false);
		setStatus(status);
	},
};
