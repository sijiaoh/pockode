import { createAuthStore } from "@pockode/shared";

function getApiBaseUrl(): string {
	return window.location.origin;
}

const { useAuthStore, selectIsAuthenticated, selectIsLoading, authActions } =
	createAuthStore({
		apiBaseUrl: getApiBaseUrl(),
	});

export { authActions, selectIsAuthenticated, selectIsLoading, useAuthStore };
