import { createAuthStore } from "@pockode/shared";

const { useAuthStore, selectHasAuthToken, authActions } = createAuthStore({
	tokenKey: "cluster_auth_token",
});

export { authActions, selectHasAuthToken, useAuthStore };
