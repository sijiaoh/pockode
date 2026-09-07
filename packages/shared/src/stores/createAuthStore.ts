import { create, type StoreApi, type UseBoundStore } from "zustand";

export interface AuthState {
	token: string | null;
}

export interface AuthStoreConfig {
	/** Key used in localStorage, e.g. "auth_token" or "cluster_auth_token" */
	tokenKey: string;
	/** Callback invoked during logout (e.g. disconnect WebSocket) */
	onLogout?: () => void;
}

export interface AuthStore {
	useAuthStore: UseBoundStore<StoreApi<AuthState>>;
	selectHasAuthToken: (state: AuthState) => boolean;
	authActions: {
		login: (token: string) => void;
		logout: () => void;
		getToken: () => string;
	};
}

/**
 * Factory function to create an auth store with configurable token key and logout behavior.
 */
export function createAuthStore(config: AuthStoreConfig): AuthStore {
	const { tokenKey, onLogout } = config;

	const useAuthStore = create<AuthState>(() => ({
		token: localStorage.getItem(tokenKey),
	}));

	const selectHasAuthToken = (state: AuthState) => !!state.token;

	const authActions = {
		login: (token: string) => {
			localStorage.setItem(tokenKey, token);
			useAuthStore.setState({ token });
		},
		logout: () => {
			localStorage.removeItem(tokenKey);
			useAuthStore.setState({ token: null });
			onLogout?.();
		},
		getToken: () => useAuthStore.getState().token ?? "",
	};

	return {
		useAuthStore,
		selectHasAuthToken,
		authActions,
	};
}
