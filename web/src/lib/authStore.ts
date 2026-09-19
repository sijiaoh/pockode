import { createAuthStore } from "@pockode/shared";

// A leaf module on purpose: the connection layer reads the credential from here
// and writes back the session token the server issues, so the dependency runs
// one way only. Tearing the socket down when the credential goes is AppShell's,
// beside the effect that opens it — see the connect/disconnect pair there.
const { useAuthStore, selectCredential, authActions } = createAuthStore({
	sessionKey: "auth_session_token",
	legacyPasswordKey: "auth_token",
});

export { authActions, selectCredential, useAuthStore };
