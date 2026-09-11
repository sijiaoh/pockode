import { describe, expect, it } from "vitest";
import {
	AUTO_EFFORT_DESCRIPTION,
	AUTO_MODEL_DESCRIPTION,
	buildChoices,
	getOptionLabel,
} from "./agentOptions";

const MODELS = [
	{ id: "opus", label: "Opus" },
	{ id: "sonnet", label: "Sonnet" },
];

describe("getOptionLabel", () => {
	it("names the empty value Auto", () => {
		expect(getOptionLabel(MODELS, "")).toBe("Auto");
	});

	it("uses the server's label", () => {
		expect(getOptionLabel(MODELS, "sonnet")).toBe("Sonnet");
	});

	// The server only drops a stale value when the agent changes, so a retired id
	// can still be what a session runs. Calling it Auto would misreport that.
	it("falls back to the id itself for a value the server no longer lists", () => {
		expect(getOptionLabel(MODELS, "opus-4")).toBe("opus-4");
	});

	it("survives the list not having arrived yet", () => {
		expect(getOptionLabel(undefined, "sonnet")).toBe("sonnet");
		expect(getOptionLabel(undefined, "")).toBe("Auto");
	});
});

describe("buildChoices", () => {
	it("puts Auto first, with the empty id the server expects", () => {
		const choices = buildChoices(MODELS, "sonnet", AUTO_MODEL_DESCRIPTION);

		expect(choices[0]).toMatchObject({ id: "", label: "Auto" });
		expect(choices.map((c) => c.id)).toEqual(["", "opus", "sonnet"]);
	});

	// Without a row of its own the list would look like nothing is selected, and
	// the choice the session actually runs would be unreachable and invisible.
	it("gives a value the server no longer lists a row below Auto", () => {
		const choices = buildChoices(MODELS, "opus-4", AUTO_MODEL_DESCRIPTION);

		expect(choices.map((c) => c.id)).toEqual(["", "opus-4", "opus", "sonnet"]);
	});

	it("adds no extra row when Auto is the current value", () => {
		expect(
			buildChoices(MODELS, "", AUTO_MODEL_DESCRIPTION).map((c) => c.id),
		).toEqual(["", "opus", "sonnet"]);
	});

	// The two lists sit in one panel: a description repeated under both Autos
	// would read as a rendering bug, and a description on every row would push
	// the panel further past what a phone shows at once.
	it("describes only Auto, in the caller's words", () => {
		const models = buildChoices(MODELS, "", AUTO_MODEL_DESCRIPTION);
		const efforts = buildChoices(
			[{ id: "high", label: "High" }],
			"",
			AUTO_EFFORT_DESCRIPTION,
		);

		expect(models[0].description).toBe(AUTO_MODEL_DESCRIPTION);
		expect(efforts[0].description).toBe(AUTO_EFFORT_DESCRIPTION);
		expect(AUTO_MODEL_DESCRIPTION).not.toBe(AUTO_EFFORT_DESCRIPTION);
		expect(models.slice(1).every((c) => c.description === undefined)).toBe(
			true,
		);
		expect(efforts.slice(1).every((c) => c.description === undefined)).toBe(
			true,
		);
	});
});
