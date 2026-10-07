import { describe, expect, it } from "vitest";
import type { AgentRole } from "../types/agentRole";
import { resolveInitialRole } from "./initialRole";
import { roleAcceptsWorkType } from "./roleWorkType";

const role = (id: string, work_type?: AgentRole["work_type"]): AgentRole => ({
	id,
	name: id,
	role_prompt: "",
	work_type,
	created_at: "2026-10-07T00:00:00Z",
	updated_at: "2026-10-07T00:00:00Z",
});

describe("roleAcceptsWorkType", () => {
	it.each([
		[undefined, "story", true],
		[undefined, "task", true],
		["story", "story", true],
		["story", "task", false],
		["task", "story", false],
		["task", "task", true],
	] as const)("role %s takes %s: %s", (workType, type, want) => {
		expect(roleAcceptsWorkType(role("r", workType), type)).toBe(want);
	});
});

describe("resolveInitialRole", () => {
	it("starts with the default role when it takes the type", () => {
		const roles = [role("pm", "story"), role("a"), role("b")];
		expect(resolveInitialRole(roles, "pm", "story")).toBe("pm");
	});

	// What the reset defaults produce for a new task: PM is the default and
	// takes stories only, and four roles take tasks.
	it("asks when the default role does not take the type", () => {
		const roles = [role("pm", "story"), role("a", "task"), role("b", "task")];
		expect(resolveInitialRole(roles, "pm", "task")).toBe("");
	});

	it("picks the only role that takes the type, whatever the default", () => {
		const roles = [role("pm", "story"), role("a", "task"), role("b", "story")];
		expect(resolveInitialRole(roles, "pm", "task")).toBe("a");
	});

	it("asks when nothing takes the type", () => {
		expect(resolveInitialRole([role("pm", "story")], "pm", "task")).toBe("");
	});

	it("does not preselect a default that is no longer in the list", () => {
		expect(resolveInitialRole([role("a"), role("b")], "gone", "story")).toBe(
			"",
		);
	});
});
