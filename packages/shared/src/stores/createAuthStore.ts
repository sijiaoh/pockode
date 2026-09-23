import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { AuthCredential } from "../utils/auth.ts";

export interface AuthState {
	/**
	 * What the password is exchanged for, so that a reconnect never has to send
	 * the password again. Random, expirable and revocable by the server, which
	 * is why this — and never the password — is the one thing an app may put in
	 * browser storage; whether it does is `persistSession`, and the cluster
	 * frontend deliberately does not.
	 */
	sessionToken: string | null;
	/**
	 * The password the user just typed, held only until the first successful
	 * auth returns a session token to replace it. It is never written to
	 * storage under any configuration, so no reload ever starts from it.
	 */
	password: string | null;
}

export interface AuthStoreConfig {
	/**
	 * localStorage key for the session token, e.g. "auth_session_token". Still
	 * required when `persistSession` is false: the key is then what gets wiped
	 * on start, because an install upgrading into that mode still has a token
	 * sitting under it and this is the only moment it can be removed.
	 */
	sessionKey: string;
	/**
	 * The key this app used to keep the user's *password* under, back when the
	 * password itself was the stored credential. Removed on every start so an
	 * existing install stops carrying a plaintext password in browser storage.
	 *
	 * TODO: Remove with the rest of the auth-token deprecations in v0.20.0.
	 */
	legacyPasswordKey: string;
	/**
	 * Whether a reload may stay signed in. Defaults to true.
	 *
	 * The cluster panel sets it to false, and not for secrecy: a credential that
	 * lives only in this tab has exactly one behaviour, which is the whole
	 * point. The argument is in docs/cluster.md, under Session Persistence
	 * (Frontend).
	 */
	persistSession?: boolean;
}

export interface AuthStore {
	useAuthStore: UseBoundStore<StoreApi<AuthState>>;
	/**
	 * The credential to connect with, and by the same token whether the user is
	 * signed in at all. A selector so a component re-renders when it changes; it
	 * builds a fresh object every call, so subscribe through `useShallow`.
	 */
	selectCredential: (state: AuthState) => AuthCredential | null;
	authActions: {
		/** The user typed a password; a connection can now be attempted. */
		login: (password: string) => void;
		/**
		 * Store the token the server issued and drop the password: from here on
		 * every reconnect and every HTTP request uses the token.
		 */
		rememberSession: (sessionToken: string) => void;
		/**
		 * Drop a session token the server no longer knows. Not a logout: it is
		 * not the user's doing, nothing is said to them, and a password still in
		 * memory is left to be tried next.
		 *
		 * That fallback needs a password that was typed *before* a token was
		 * issued, since `rememberSession` clears it; only a restored token can
		 * produce that order, so it exists for apps that persist one.
		 */
		forgetSession: () => void;
		logout: () => void;
		/** Null when there is nothing to authenticate with. */
		getCredential: () => AuthCredential | null;
		/** Bearer value for HTTP; "" when not authenticated. */
		getBearer: () => string;
	};
}

/**
 * Factory function to create an auth store: each app brings its own storage
 * keys, and says whether a session may be stored at all (`persistSession`).
 */
export function createAuthStore(config: AuthStoreConfig): AuthStore {
	const { sessionKey, legacyPasswordKey, persistSession = true } = config;

	localStorage.removeItem(legacyPasswordKey);
	// Not writing a token from here on does not unwrite the one an earlier
	// version left behind. This start is the only chance to clear it.
	//
	// TODO: Remove alongside legacyPasswordKey in v0.20.0 — by then every
	// install that ever stored one has run this once, and nothing writes the
	// key in this mode for it to find again.
	if (!persistSession) localStorage.removeItem(sessionKey);

	const useAuthStore = create<AuthState>(() => ({
		sessionToken: persistSession ? localStorage.getItem(sessionKey) : null,
		password: null,
	}));

	const storeSession = (sessionToken: string | null) => {
		if (!persistSession) return;
		if (sessionToken === null) localStorage.removeItem(sessionKey);
		else localStorage.setItem(sessionKey, sessionToken);
	};

	const selectCredential = (state: AuthState): AuthCredential | null => {
		// The token wins whenever there is one: it is what the password was
		// exchanged for, and the password is gone the moment that happens.
		if (state.sessionToken)
			return { kind: "session_token", value: state.sessionToken };
		if (state.password) return { kind: "password", value: state.password };
		return null;
	};

	const authActions = {
		login: (password: string) => {
			useAuthStore.setState({ password });
		},
		rememberSession: (sessionToken: string) => {
			storeSession(sessionToken);
			useAuthStore.setState({ sessionToken, password: null });
		},
		forgetSession: () => {
			storeSession(null);
			useAuthStore.setState({ sessionToken: null });
		},
		logout: () => {
			storeSession(null);
			useAuthStore.setState({ sessionToken: null, password: null });
		},
		getCredential: (): AuthCredential | null =>
			selectCredential(useAuthStore.getState()),
		getBearer: () => authActions.getCredential()?.value ?? "",
	};

	return {
		useAuthStore,
		selectCredential,
		authActions,
	};
}
