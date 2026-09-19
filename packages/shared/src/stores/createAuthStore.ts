import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { AuthCredential } from "../utils/auth.ts";

export interface AuthState {
	/**
	 * The credential that survives a reload. Random, expirable and revocable by
	 * the server, which is why this — and never the password — is the one thing
	 * kept in browser storage.
	 */
	sessionToken: string | null;
	/**
	 * The password the user just typed, held only until the first successful
	 * auth returns a session token to replace it. It is never written to
	 * storage, so a reload starts from the session token alone.
	 */
	password: string | null;
}

export interface AuthStoreConfig {
	/** localStorage key for the session token, e.g. "auth_session_token". */
	sessionKey: string;
	/**
	 * The key this app used to keep the user's *password* under, back when the
	 * password itself was the stored credential. Removed on every start so an
	 * existing install stops carrying a plaintext password in browser storage.
	 *
	 * TODO: Remove with the rest of the auth-token deprecations in v0.20.0.
	 */
	legacyPasswordKey: string;
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
		 * One load reaches that fallback — the cluster opened from a
		 * `?password=` link while storage still holds a lapsed token. A password
		 * typed after a token was issued is already gone, because
		 * `rememberSession` clears it.
		 */
		forgetSession: () => void;
		logout: () => void;
		/** Null when there is nothing to authenticate with. */
		getCredential: () => AuthCredential | null;
		/** Bearer value for HTTP; "" when not authenticated. */
		getBearer: () => string;
	};
}

/** Factory function to create an auth store with configurable storage keys. */
export function createAuthStore(config: AuthStoreConfig): AuthStore {
	const { sessionKey, legacyPasswordKey } = config;

	localStorage.removeItem(legacyPasswordKey);

	const useAuthStore = create<AuthState>(() => ({
		sessionToken: localStorage.getItem(sessionKey),
		password: null,
	}));

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
			localStorage.setItem(sessionKey, sessionToken);
			useAuthStore.setState({ sessionToken, password: null });
		},
		forgetSession: () => {
			localStorage.removeItem(sessionKey);
			useAuthStore.setState({ sessionToken: null });
		},
		logout: () => {
			localStorage.removeItem(sessionKey);
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
