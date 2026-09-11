import type { ModelOption } from "../types/message";

/**
 * Presentation layer only. The list of selectable models lives on the server
 * (`session.models`), which is also what validates a choice — a second copy here
 * would drift and offer options the server rejects.
 */

/** The empty model the server reads as "pass no model flag to the CLI". */
export const AUTO_MODEL_ID = "";

/**
 * The name for the empty model is a frontend decision; the server has no label
 * for it. Not "Default": that is already the name of a session mode, and the two
 * sit side by side in the same action bar.
 */
const AUTO_MODEL_LABEL = "Auto";
const AUTO_MODEL_DESCRIPTION = "Let the CLI decide";

export interface ModelChoice {
	id: string;
	label: string;
	description?: string;
}

const AUTO_CHOICE: ModelChoice = {
	id: AUTO_MODEL_ID,
	label: AUTO_MODEL_LABEL,
	description: AUTO_MODEL_DESCRIPTION,
};

/**
 * What the chip shows for a model id. An id the server no longer lists is shown
 * as itself rather than rewritten to Auto: the session really is still set to it
 * (the server only clears a stale model when the agent changes), and presenting
 * someone else's choice as Auto would be a lie.
 */
export function getModelLabel(
	models: ModelOption[] | undefined,
	model: string,
): string {
	if (model === AUTO_MODEL_ID) return AUTO_MODEL_LABEL;
	return models?.find((m) => m.id === model)?.label ?? model;
}

/**
 * The rows of the model list: Auto first, then the agent's models. When the
 * session's current model is not among them it gets a row of its own, right
 * below Auto, so the selected value is always visible and selectable-looking
 * instead of the list appearing to have nothing checked.
 */
export function buildModelChoices(
	models: ModelOption[] | undefined,
	current: string,
): ModelChoice[] {
	const listed = models ?? [];
	const choices: ModelChoice[] = [AUTO_CHOICE];

	if (current !== AUTO_MODEL_ID && !listed.some((m) => m.id === current)) {
		choices.push({ id: current, label: current });
	}

	for (const m of listed) {
		choices.push({ id: m.id, label: m.label });
	}

	return choices;
}
