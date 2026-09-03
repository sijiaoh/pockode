import { describe, expect, it } from "vitest";
import { getSessionModeInfo } from "./sessionMode";

describe("getSessionModeInfo", () => {
	// Default is not the same promise on both CLIs: Claude prompts per edit and
	// command, Codex only prompts when leaving its workspace sandbox. Merging
	// these back into one shared string would silently overpromise for Codex.
	it("describes default mode differently per agent", () => {
		expect(getSessionModeInfo("default", "codex").description).not.toBe(
			getSessionModeInfo("default", "claude").description,
		);
	});
});
