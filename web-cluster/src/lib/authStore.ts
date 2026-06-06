import { create } from "zustand";

const TOKEN_KEY = "cluster_auth_token";

interface AuthState {
	token: string | null;
}

export const useAuthStore = create<AuthState>(() => ({
	token: localStorage.getItem(TOKEN_KEY),
}));

export const selectHasAuthToken = (state: AuthState) => !!state.token;

export const authActions = {
	login: (token: string) => {
		localStorage.setItem(TOKEN_KEY, token);
		useAuthStore.setState({ token });
	},
	logout: () => {
		localStorage.removeItem(TOKEN_KEY);
		useAuthStore.setState({ token: null });
	},
	getToken: () => useAuthStore.getState().token ?? "",
};
