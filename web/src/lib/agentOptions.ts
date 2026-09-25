import type { AgentOption } from "../types/message";

/**
 * Presentation layer only. Both lists of options an agent offers — its models
 * and its effort levels — live on the server (`session.models`,
 * `session.efforts`), which is also what validates a choice; a second copy here
 * would drift and offer options the server rejects.
 */

/** The empty value the server reads as "pass no flag, let the CLI decide". */
export const AUTO_ID = "";

/**
 * The name for the empty value is a frontend decision; the server has no label
 * for it. Not "Default": that is already the name of a session mode, and the two
 * sit side by side in the same action bar. The same word for both settings — the
 * legend above each list is what says which one it means.
 */
const AUTO_LABEL = "Auto";

/**
 * What Auto means differs per setting, and the two descriptions sit in one
 * panel: repeating a single line under both would read as a rendering bug.
 */
export const AUTO_MODEL_DESCRIPTION = "Let the CLI decide";
export const AUTO_EFFORT_DESCRIPTION = "Follow the CLI default";

/**
 * What Auto means on an agent role that sits on the global default agent: the
 * server fills the empty value in from Settings field by field, so the CLI never
 * gets to decide and the two descriptions above would be untrue. The resolved
 * value is named here rather than left for the reader to go look up, because
 * that trip to the Settings page is the expensive one on a phone.
 *
 * Not worded as "Follow settings" — that row name belongs to the agent section,
 * where the whole engine follows Settings rather than this one field.
 */
export const fromSettingsDescription = (label: string) =>
	`From Settings: ${label}`;

export interface Choice {
	id: string;
	label: string;
	description?: string;
}

/**
 * What the chip shows for an id. An id the server no longer lists is shown as
 * itself rather than rewritten to Auto: the session really is still set to it
 * (the server only clears a stale value when the agent changes), and presenting
 * someone else's choice as Auto would be a lie.
 */
export function getOptionLabel(
	options: AgentOption[] | undefined,
	id: string,
): string {
	if (id === AUTO_ID) return AUTO_LABEL;
	return options?.find((o) => o.id === id)?.label ?? id;
}

/**
 * The rows of one list: Auto first, then the agent's options. When the session's
 * current value is not among them it gets a row of its own, right below Auto, so
 * the selected value is always visible and selectable-looking instead of the
 * list appearing to have nothing checked.
 *
 * Only Auto carries a description. For the others the label is the whole
 * meaning, and a second line per row would push the panel further past what a
 * phone can show at once.
 */
export function buildChoices(
	options: AgentOption[] | undefined,
	current: string,
	autoDescription: string,
): Choice[] {
	const listed = options ?? [];
	const choices: Choice[] = [
		{ id: AUTO_ID, label: AUTO_LABEL, description: autoDescription },
	];

	if (current !== AUTO_ID && !listed.some((o) => o.id === current)) {
		choices.push({ id: current, label: current });
	}

	for (const o of listed) {
		choices.push({ id: o.id, label: o.label });
	}

	return choices;
}

/**
 * The empty agent type. Not called Auto, though the empty model and effort are:
 * this one points at a value the user set themselves in Settings and can go
 * read, while Auto hands the decision to the CLI. The three sit in one panel, so
 * one word for both would say they mean the same thing.
 */
export const FOLLOW_SETTINGS_ID = "";
export const FOLLOW_SETTINGS_LABEL = "Follow settings";
export const FOLLOW_SETTINGS_DESCRIPTION =
	"Use the default engine from Settings";

export interface EngineSummary {
	/** The agent's own label; null when the role defers to Settings. */
	agentLabel: string | null;
	modelLabel: string;
	/** Null on Auto: whichever level the CLI then picks is its own business. */
	effortLabel: string | null;
	/** The one line both the collapsed engine field and the role row print. */
	text: string;
}

/**
 * One engine written as one line, for the two places that write it: the agent
 * role page's collapsed engine row and the agent role list's row. A second
 * copy of this joining is how the two would start saying different things about
 * one record.
 *
 * `agentLabel` is null, never resolved from Settings, when the role names no
 * agent: the record really does say "follow settings", and an unresolved
 * snapshot resolves to the most reassuring engine there is — Claude on Auto —
 * which is the one answer a user on Codex must not be shown.
 */
export function describeEngine({
	agentLabel,
	models,
	model,
	efforts,
	effort,
}: {
	agentLabel: string | null;
	models: AgentOption[] | undefined;
	model: string;
	efforts: AgentOption[] | undefined;
	effort: string;
}): EngineSummary {
	const modelLabel = getOptionLabel(models, model);
	const effortLabel =
		effort === AUTO_ID ? null : getOptionLabel(efforts, effort);
	return {
		agentLabel,
		modelLabel,
		effortLabel,
		text: agentLabel
			? [agentLabel, modelLabel, effortLabel].filter(Boolean).join(" · ")
			: FOLLOW_SETTINGS_LABEL,
	};
}
