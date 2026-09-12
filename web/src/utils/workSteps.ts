import type { AgentRole } from "../types/agentRole";
import type { Work } from "../types/work";

export interface StepProgress {
	/**
	 * 0-based index of the step the work sits on, clamped into range. Points at
	 * the last step once `isComplete`, where the work sits past all of them.
	 */
	currentStep: number;
	totalSteps: number;
	/**
	 * Every step is behind the work. Not the same as sitting on the last step:
	 * an in-progress work does that too, without being done with it.
	 */
	isComplete: boolean;
}

/**
 * Null when the role defines no steps, or when the work has not started yet —
 * an `open` work sits on no step, so claiming "Step 1/3" would be a lie.
 */
export function getStepProgress(
	work: Pick<Work, "status" | "current_step">,
	role: AgentRole | undefined,
): StepProgress | null {
	const totalSteps = role?.steps?.length ?? 0;
	if (totalSteps === 0 || work.status === "open") return null;

	if (work.status === "closed") {
		return { currentStep: totalSteps - 1, totalSteps, isComplete: true };
	}

	return {
		currentStep: Math.max(0, Math.min(work.current_step ?? 0, totalSteps - 1)),
		totalSteps,
		isComplete: false,
	};
}

/** The bare counter, e.g. `2/3`. */
export function formatStepCount(progress: StepProgress): string {
	const shown = progress.isComplete
		? progress.totalSteps
		: progress.currentStep + 1;
	return `${shown}/${progress.totalSteps}`;
}

/** The counter with its label, e.g. `Step 2/3`. */
export function formatStepProgress(progress: StepProgress): string {
	return `Step ${formatStepCount(progress)}`;
}

/**
 * The step recorded on a past system message, expressed as progress so it
 * formats through the same functions as the live one. `current` is 1-indexed,
 * matching the wire format.
 */
export function recordedStepProgress(
	current: number,
	total: number,
): StepProgress {
	return { currentStep: current - 1, totalSteps: total, isComplete: false };
}
