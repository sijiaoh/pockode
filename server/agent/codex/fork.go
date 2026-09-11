package codex

// This file holds no code, on purpose: implementing nothing is the whole of how
// an agent says its sessions cannot be forked. Codex implements no
// agent.SessionForker, so agent.ForkSupportOf answers agent.ForkUnsupported for
// it and nothing asks it anything further. What is left to keep here is why.
//
// A Codex thread lives in the memory of the mcp-server process that created it,
// so nothing outside that process can reopen it (see warnSessionNotResumable).
// Verified against codex-cli 0.153.0: its MCP server offers exactly two tools,
// `codex` (start a thread) and `codex-reply` (continue one by id), and a second
// process answering a thread id from the first gets "Session not found for
// thread_id". The CLI has grown a `codex exec fork <SESSION_ID>` of its own since,
// but it is out of reach through the MCP channel Pockode speaks, and it takes
// nothing but a session id — so even reaching it would fork whole conversations
// only, never one at a chosen message.
//
// Even a fork taken from a still-live source is out of reach: the fork runs in its
// own process, and pointing it at the source's thread would not fork the
// conversation but share it, each session writing turns the other never asked for.
//
// Saying so by absence, rather than implementing a ForkSession that returns
// false, is what lets Pockode refuse the fork up front, which is the honest
// answer: a Codex session forked anyway would put the user in front of a
// transcript its agent has never seen.
