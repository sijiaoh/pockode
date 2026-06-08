import { createAuthStore } from "@pockode/shared";
import { wsActions } from "./wsStore";

function getApiBaseUrl(): string {
	return window.location.origin;
}

const { useAuthStore, selectIsAuthenticated, selectIsLoading, authActions } =
	createAuthStore({
		apiBaseUrl: getApiBaseUrl(),
		onLogout: () => wsActions.disconnect(),
	});

export { authActions, selectIsAuthenticated, selectIsLoading, useAuthStore };
