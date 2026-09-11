import { describe, expect, it } from "vitest";
import { buildModelChoices, getModelLabel } from "./agentModel";

const MODELS = [
	{ id: "opus", label: "Opus" },
	{ id: "sonnet", label: "Sonnet" },
];

describe("getModelLabel", () => {
	it("names the empty model Auto", () => {
		expect(getModelLabel(MODELS, "")).toBe("Auto");
	});

	it("uses the server's label", () => {
		expect(getModelLabel(MODELS, "sonnet")).toBe("Sonnet");
	});

	// The server only drops a stale model when the agent changes, so a retired id
	// can still be what a session runs. Calling it Auto would misreport that.
	it("falls back to the id itself for a model the server no longer lists", () => {
		expect(getModelLabel(MODELS, "opus-4")).toBe("opus-4");
	});

	it("survives the list not having arrived yet", () => {
		expect(getModelLabel(undefined, "sonnet")).toBe("sonnet");
		expect(getModelLabel(undefined, "")).toBe("Auto");
	});
});

describe("buildModelChoices", () => {
	it("puts Auto first, with the empty id the server expects", () => {
		const choices = buildModelChoices(MODELS, "sonnet");

		expect(choices[0]).toMatchObject({ id: "", label: "Auto" });
		expect(choices.map((c) => c.id)).toEqual(["", "opus", "sonnet"]);
	});

	// Without a row of its own the list would look like nothing is selected, and
	// the choice the session actually runs would be unreachable and invisible.
	it("gives a model the server no longer lists a row below Auto", () => {
		const choices = buildModelChoices(MODELS, "opus-4");

		expect(choices.map((c) => c.id)).toEqual(["", "opus-4", "opus", "sonnet"]);
	});

	it("adds no extra row when Auto is the current model", () => {
		expect(buildModelChoices(MODELS, "").map((c) => c.id)).toEqual([
			"",
			"opus",
			"sonnet",
		]);
	});
});
