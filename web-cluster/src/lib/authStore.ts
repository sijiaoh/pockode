import { createAuthStore } from "@pockode/shared";

// See web/src/lib/authStore.ts: a leaf module, written to by the connection
// layer rather than importing it.
//
// persistSession is off on purpose, and it is the whole point of this file:
// nothing the cluster panel authenticates with is ever written to browser
// storage, so every load — new tab, reload, restored tab — starts at the
// password screen. The reasoning is in docs/cluster.md, under Session
// Persistence (Frontend). The session token is still obtained and still used,
// just only by this tab, so reconnects never resend the password.
//
// Nothing in the cluster UI renders off this store: which screen is up is
// decided by the connection status (see App), and the connection works from its
// own copy of the credential. What lives here is the tab's record of what it is
// authenticated with — kept truthful for that reason, not as a render source.
const { useAuthStore, authActions } = createAuthStore({
	sessionKey: "cluster_auth_session_token",
	legacyPasswordKey: "cluster_auth_token",
	persistSession: false,
});

// selectCredential is not re-exported the way web does it: nothing here
// subscribes to the credential, because nothing renders off it.
export { authActions, useAuthStore };
