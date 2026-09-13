import type { SessionMode } from "./message";

export type AgentType = "claude" | "codex";

/**
 * Whether an agent can follow a fork of a conversation, and from where, declared
 * by the agent itself and delivered by the server (`agent.list`).
 *
 * The frontend keeps no opinion of its own about which agent can do what: every
 * difference on this subject is one of these values, so the UI asks what an agent
 * supports rather than which agent it is. Mirrors `agent.ForkSupport` in Go.
 *
 * - `none` — the agent cannot reopen an earlier conversation at all, so its
 *   sessions cannot be forked and the server refuses to.
 * - `any_message` — it can reopen a conversation at a chosen message in it, so a
 *   fork from anywhere can carry that memory.
 */
export type ForkSupport = "none" | "any_message";

export interface Settings {
	default_agent_role_id?: string;
	default_agent_type?: AgentType;
	default_mode?: SessionMode;
	// The model and effort new sessions start with, both belonging to
	// `default_agent_type`: each is picked from that agent's own list, so the
	// server refuses a pair left over from the agent the user just switched away
	// from. Switching the agent must send all three fields, the latter two empty.
	// Empty = no flag is passed and the CLI decides.
	default_model?: string;
	default_effort?: string;
	// Empty = default (`../<repo>-worktrees`). Non-empty may be an absolute path,
	// a repo-relative `./`/`../` path, or a home-relative `~/` path; the backend
	// validates and rejects invalid values.
	worktree_base_dir?: string;
}

export interface SettingsSubscribeResult {
	settings: Settings;
}

export interface SettingsChangedNotification {
	id: string;
	settings: Settings;
}
