import { describe, expect, it } from "vitest";
import { forkBlockedReason } from "./agentType";

// Asked about a capability, never about an agent by name — which agent declares
// what is the server's business.
describe("forkBlockedReason", () => {
	it("blocks forking only for an agent that cannot reopen a conversation", () => {
		expect(forkBlockedReason("claude", "none")).toMatch(/cannot be forked/);
		expect(forkBlockedReason("claude", "any_message")).toBeUndefined();
		// Not yet answered for: no reason to give, and the server still refuses if
		// one applied.
		expect(forkBlockedReason("claude", null)).toBeUndefined();
	});

	// Not "Pockode could not fork this": the user should look for another way to
	// get what they wanted, not for a retry.
	it("names the agent and points at the missing ability, not at a failure", () => {
		expect(forkBlockedReason("codex", "none")).toBe(
			"Codex cannot reopen an earlier conversation, so its sessions cannot be forked.",
		);
	});
});
