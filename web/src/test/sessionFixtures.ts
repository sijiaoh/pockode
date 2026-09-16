import type { SessionDetail, SessionListItem } from "../types/message";

/**
 * A freshly created session, as `session.detail` reports it: no agent has
 * answered in it and every setting is the CLI's own default. Tests override
 * only the fields their case is about.
 */
export function makeSessionDetail(
	overrides: Partial<SessionDetail> = {},
): SessionDetail {
	return {
		id: "s1",
		title: "Test",
		created_at: "2024-01-01T00:00:00Z",
		updated_at: "2024-01-01T00:00:00Z",
		mode: "default",
		agent_type: "claude",
		model: "",
		effort: "",
		activated: false,
		turn: { phase: "idle", open: false, since: "2024-01-01T00:00:00Z" },
		unread: false,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		},
		...overrides,
	};
}

/**
 * One row of a session list, as `session.list` reports it. A row is not a
 * session: everything a case wants to say about settings belongs in
 * `makeSessionDetail` instead.
 */
export function makeSessionListItem(
	overrides: Partial<SessionListItem> = {},
): SessionListItem {
	return {
		id: "s1",
		title: "Test",
		updated_at: "2024-01-01T00:00:00Z",
		state: "ended",
		needs_input: false,
		unread: false,
		...overrides,
	};
}
