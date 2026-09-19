import { createAuthStore } from "@pockode/shared";

// See web/src/lib/authStore.ts: a leaf module, written to by the connection
// layer rather than importing it.
const { useAuthStore, selectCredential, authActions } = createAuthStore({
	sessionKey: "cluster_auth_session_token",
	legacyPasswordKey: "cluster_auth_token",
});

export { authActions, selectCredential, useAuthStore };
