import { createAuthStore } from "@pockode/shared-ui";
import { wsActions } from "./wsStore";

const { useAuthStore, selectHasAuthToken, authActions } = createAuthStore({
	tokenKey: "auth_token",
	onLogout: () => wsActions.disconnect(),
});

export { authActions, selectHasAuthToken, useAuthStore };
