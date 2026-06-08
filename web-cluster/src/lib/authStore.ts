import { createAuthStore } from "@pockode/shared";

function getApiBaseUrl(): string {
	return window.location.origin;
}

const { useAuthStore, selectIsAuthenticated, authActions } = createAuthStore({
	apiBaseUrl: getApiBaseUrl(),
});

export { authActions, selectIsAuthenticated, useAuthStore };
