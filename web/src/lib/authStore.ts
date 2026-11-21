import { createAuthStore } from "@pockode/shared";
import type { AppAuthCredential } from "./loginTicket";

// A leaf module on purpose: the connection layer reads the credential from here
// and writes back the session token the server issues, so the dependency runs
// one way only. Tearing the socket down when the credential goes is AppShell's,
// beside the effect that opens it — see the connect/disconnect pair there.
const shared = createAuthStore({
	sessionKey: "auth_session_token",
	legacyPasswordKey: "auth_token",
});
const { useAuthStore } = shared;
type AuthState = ReturnType<typeof useAuthStore.getState>;

/**
 * The login ticket this tab was opened with, until the first `auth` has
 * carried it. Memory only: it is worthless once sent, and a copy anywhere that
 * outlives the page is a copy a later visitor could find. Beside the store
 * rather than in it, because the shared store's state is the cluster's too,
 * and the cluster has no tickets.
 */
let loginTicket: string | null = null;

function selectCredential(state: AuthState): AppAuthCredential | null {
	const stored = shared.selectCredential(state);
	if (!loginTicket) return stored;
	return {
		kind: "login_ticket",
		value: loginTicket,
		sessionToken: stored?.kind === "session_token" ? stored.value : null,
	};
}

function setLoginTicket(ticket: string | null) {
	loginTicket = ticket;
	// The ticket is part of what the selector answers, so its subscribers
	// have to read again.
	useAuthStore.setState({});
}

const authActions = {
	...shared.authActions,
	/** Connect with this ticket first; see `takeLoginTicketFromAddress`. */
	holdLoginTicket: (ticket: string) => setLoginTicket(ticket),
	/**
	 * The first `auth` carried the ticket and the server spent it, whatever
	 * the outcome, so nothing may send it again.
	 */
	dropLoginTicket: () => {
		if (loginTicket !== null) setLoginTicket(null);
	},
	logout: () => {
		loginTicket = null;
		shared.authActions.logout();
	},
	getCredential: (): AppAuthCredential | null =>
		selectCredential(useAuthStore.getState()),
};

export { authActions, selectCredential, useAuthStore };
