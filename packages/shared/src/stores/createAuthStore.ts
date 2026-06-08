import { create, type StoreApi, type UseBoundStore } from "zustand";

export interface AuthState {
	isAuthenticated: boolean;
	isLoading: boolean;
}

export interface AuthStoreConfig {
	/** API base URL for login/logout requests (e.g., window.location.origin) */
	apiBaseUrl: string;
	/** Callback invoked during logout (e.g. disconnect WebSocket) */
	onLogout?: () => void;
}

export interface AuthStore {
	useAuthStore: UseBoundStore<StoreApi<AuthState>>;
	selectIsAuthenticated: (state: AuthState) => boolean;
	selectIsLoading: (state: AuthState) => boolean;
	authActions: {
		login: (token: string) => Promise<boolean>;
		logout: () => Promise<void>;
		setAuthenticated: (value: boolean) => void;
		checkAuth: () => Promise<void>;
	};
}

/**
 * Factory function to create an auth store with configurable API base URL and logout behavior.
 * The store only tracks authentication state; actual auth is handled via HttpOnly cookies.
 */
export function createAuthStore(config: AuthStoreConfig): AuthStore {
	const { apiBaseUrl, onLogout } = config;

	const useAuthStore = create<AuthState>(() => ({
		isAuthenticated: false,
		isLoading: true,
	}));

	const selectIsAuthenticated = (state: AuthState) => state.isAuthenticated;
	const selectIsLoading = (state: AuthState) => state.isLoading;

	const authActions = {
		login: async (token: string): Promise<boolean> => {
			try {
				const response = await fetch(`${apiBaseUrl}/api/login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ token }),
					credentials: "include",
				});
				if (response.ok) {
					useAuthStore.setState({ isAuthenticated: true });
					return true;
				}
				return false;
			} catch {
				return false;
			}
		},
		logout: async (): Promise<void> => {
			try {
				await fetch(`${apiBaseUrl}/api/logout`, {
					method: "POST",
					credentials: "include",
				});
			} catch {
				// Ignore errors - we'll clear state anyway
			}
			useAuthStore.setState({ isAuthenticated: false });
			onLogout?.();
		},
		setAuthenticated: (value: boolean) => {
			useAuthStore.setState({ isAuthenticated: value });
		},
		checkAuth: async (): Promise<void> => {
			try {
				const response = await fetch(`${apiBaseUrl}/api/me`, {
					credentials: "include",
				});
				useAuthStore.setState({
					isAuthenticated: response.ok,
					isLoading: false,
				});
			} catch {
				useAuthStore.setState({ isAuthenticated: false, isLoading: false });
			}
		},
	};

	return {
		useAuthStore,
		selectIsAuthenticated,
		selectIsLoading,
		authActions,
	};
}
