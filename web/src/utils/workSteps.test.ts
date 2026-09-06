import { describe, expect, it } from "vitest";
import type { AgentRole } from "../types/agentRole";
import type { WorkStatus } from "../types/work";
import {
	formatStepProgress,
	getStepProgress,
	recordedStepProgress,
} from "./workSteps";

const role = (steps?: string[]): AgentRole => ({
	id: "role-1",
	name: "Engineer",
	role_prompt: "",
	steps,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
});

const work = (status: WorkStatus, current_step?: number) => ({
	status,
	current_step,
});

describe("getStepProgress", () => {
	it("returns null when the role defines no steps", () => {
		expect(getStepProgress(work("in_progress", 1), role())).toBeNull();
		expect(getStepProgress(work("in_progress", 1), role([]))).toBeNull();
		expect(getStepProgress(work("in_progress", 1), undefined)).toBeNull();
	});

	// An open work sits on no step yet, so "Step 1/3" would overstate progress.
	it("returns null while the work has not started", () => {
		expect(getStepProgress(work("open", 0), role(["a", "b"]))).toBeNull();
	});

	it("reports the current step for active work", () => {
		expect(
			getStepProgress(work("in_progress", 1), role(["a", "b", "c"])),
		).toEqual({ currentStep: 1, totalSteps: 3, isComplete: false });
	});

	it("reports every step done once the work is closed", () => {
		expect(getStepProgress(work("closed", 0), role(["a", "b", "c"]))).toEqual({
			currentStep: 2,
			totalSteps: 3,
			isComplete: true,
		});
	});

	// current_step can outrun the role's steps when the role is edited afterwards.
	it("clamps a current step that is out of range", () => {
		expect(
			getStepProgress(work("stopped", 9), role(["a", "b"]))?.currentStep,
		).toBe(1);
		expect(
			getStepProgress(work("stopped", -3), role(["a", "b"]))?.currentStep,
		).toBe(0);
	});
});

describe("formatStepProgress", () => {
	it("counts from one", () => {
		expect(
			formatStepProgress({ currentStep: 1, totalSteps: 3, isComplete: false }),
		).toBe("Step 2/3");
	});

	it("shows the total for completed work", () => {
		expect(
			formatStepProgress({ currentStep: 2, totalSteps: 3, isComplete: true }),
		).toBe("Step 3/3");
	});
});

describe("recordedStepProgress", () => {
	it("formats a message's recorded step like a live one", () => {
		expect(formatStepProgress(recordedStepProgress(2, 3))).toBe("Step 2/3");
	});
});
