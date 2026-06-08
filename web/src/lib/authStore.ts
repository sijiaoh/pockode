import { createAuthStore } from "@pockode/shared";
import { getApiBaseUrl } from "../utils/config";
import { wsActions } from "./wsStore";

const { useAuthStore, selectIsAuthenticated, authActions } = createAuthStore({
	apiBaseUrl: getApiBaseUrl(),
	onLogout: () => wsActions.disconnect(),
});

export { authActions, selectIsAuthenticated, useAuthStore };
