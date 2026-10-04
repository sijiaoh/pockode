import { RotateCcw } from "lucide-react";
import { useId } from "react";
import {
	AUTO_EFFORT_DESCRIPTION,
	AUTO_ID,
	AUTO_MODEL_DESCRIPTION,
	buildChoices,
	getOptionLabel,
} from "../../lib/agentOptions";
import {
	useAgentOptionsStore,
	useEffortsForAgent,
	useModelsForAgent,
} from "../../lib/agentOptionsStore";
import {
	AGENT_TYPE_INFO,
	AGENT_TYPES,
	type AgentTypeInfo,
	getAgentInfo,
} from "../../lib/agentType";
import type { AgentOption } from "../../types/message";
import type { AgentType } from "../../types/settings";
import { ChoiceRow, Section } from "../ui/ChoiceList";

interface EngineValues {
	agentType: AgentType;
	/** Empty means Auto — the CLI picks. */
	model: string;
	/** Empty means Auto — the CLI keeps its own default. */
	effort: string;
	/**
	 * False while the session has yet to describe itself — it is not resolved
	 * yet, or its metadata has not arrived — so `model` and `effort` are
	 * placeholders and there is no value to name.
	 */
	hasSessionSettings: boolean;
}

export interface EngineSummary {
	agentInfo: AgentTypeInfo;
	modelLabel: string;
	/** Null for Auto: the effort the CLI then picks is its own business. */
	effortLabel: string | null;
	/** Whether the model and effort can be named yet. */
	hasLabel: boolean;
}

/**
 * How the session's engine reads in words, for every place that names it
 * outside the panel that changes it.
 */
export function useEngineSummary({
	agentType,
	model,
	effort,
	hasSessionSettings,
}: EngineValues): EngineSummary {
	const models = useModelsForAgent(agentType);
	const efforts = useEffortsForAgent(agentType);
	const optionsError = useAgentOptionsStore((s) => s.error);

	// Auto needs no list to be named, and a list that failed to load is never
	// coming — anything else would show the raw id for a moment and then correct
	// itself, or hang on a skeleton forever. Both values have to be nameable
	// before either is shown: they are read as one string, so naming one of them
	// early is the same flash.
	const canName = (id: string, options: AgentOption[] | undefined) =>
		id === AUTO_ID || options !== undefined || optionsError !== null;

	return {
		agentInfo: getAgentInfo(agentType),
		modelLabel: getOptionLabel(models, model),
		effortLabel: effort === AUTO_ID ? null : getOptionLabel(efforts, effort),
		hasLabel:
			hasSessionSettings && canName(model, models) && canName(effort, efforts),
	};
}

interface Props extends Omit<EngineValues, "hasSessionSettings"> {
	onAgentTypeChange: (type: AgentType) => Promise<void>;
	onModelChange: (model: string) => Promise<void>;
	onEffortChange: (effort: string) => Promise<void>;
	/** A change was refused; the caller reports why, outside the panel. */
	onFailure: () => void;
	/** The agent has answered here: its choice is locked and a switch restarts the CLI. */
	isSessionActivated: boolean;
	disabled?: boolean;
}

/**
 * Agent, model and effort as one choice in three levels: both lists are decided
 * by the agent. The content of a panel the caller owns — it supplies neither
 * padding nor scrolling.
 */
function EngineSections({
	agentType,
	model,
	effort,
	onAgentTypeChange,
	onModelChange,
	onEffortChange,
	onFailure,
	isSessionActivated,
	disabled = false,
}: Props) {
	// Radio `name` is document-wide; scope it so a second selector on the page
	// cannot steal this one's selection.
	const groupId = useId();

	const models = useModelsForAgent(agentType);
	const efforts = useEffortsForAgent(agentType);
	const optionsError = useAgentOptionsStore((s) => s.error);

	const agentInfo = getAgentInfo(agentType);
	const modelChoices = buildChoices(models, model, AUTO_MODEL_DESCRIPTION);
	const effortChoices = buildChoices(efforts, effort, AUTO_EFFORT_DESCRIPTION);

	// Until an answer arrives the section is hidden outright: whether this agent
	// has effort levels at all is not yet known, and the "Loading models…" line
	// above already says the panel is waiting. A failed fetch counts as an
	// answer — Auto and the current level are this layer's to offer regardless.
	const effortsAnswered = efforts !== undefined || optionsError !== null;
	// An agent the server left out of the map has no effort setting. Said in
	// words rather than by hiding the section, which at the bottom of a panel
	// nobody can see the end of is indistinguishable from still loading — except
	// while the session is still set to a level from before the server dropped
	// them, which has to stay visible and clearable.
	const effortUnavailable = efforts?.length === 0 && effort === AUTO_ID;

	// Changing the agent is the one thing the server refuses once it has answered.
	const agentLocked = disabled || isSessionActivated;
	// Once the agent is locked the alternatives are not a choice, and listing them
	// costs a scroll that a third section has made expensive. The line below the
	// section says why only one is left. That one row reuses `agentInfo` rather
	// than looking the type up again: it is the copy that survives an agent type
	// this build has no entry for, and the locked row is the only one that can be
	// such a type.
	const agentChoices = isSessionActivated
		? [{ type: agentType, info: agentInfo }]
		: AGENT_TYPES.map((type) => ({ type, info: AGENT_TYPE_INFO[type] }));

	// Every section stays open on success and closes on failure, and the reasons are
	// the same for each. Open, because a radio group selects as the arrow keys
	// move through it: closing on selection would leave a keyboard user able to
	// reach only the option next to the current one. And because seeing the dot
	// move — or the model list swap to the new agent's — is the confirmation.
	// Closed on failure, because the caller reports the reason outside this panel,
	// which the drawer covers below the expanded tier.
	const applyChoice = async (change: () => Promise<void>) => {
		try {
			await change();
		} catch {
			onFailure();
		}
	};

	const handleSelectAgent = (type: AgentType) =>
		applyChoice(() => onAgentTypeChange(type));

	const handleSelectModel = (id: string) =>
		applyChoice(() => onModelChange(id));

	const handleSelectEffort = (id: string) =>
		applyChoice(() => onEffortChange(id));

	return (
		<>
			{/* First, not last: three sections put the end of this panel below the
			    fold on every phone, and a warning nobody scrolls to is not a
			    warning. Not "switching model" either — changing the agent or the
			    effort restarts the CLI too, so one line covers the whole panel.
			    Inside the scrolling content rather than the drawer header, which
			    the dropdown at and above the expanded tier does not have. */}
			{isSessionActivated && (
				<p className="flex items-start gap-1.5 px-3 pt-3 text-xs text-th-text-muted">
					<RotateCcw className="mt-0.5 size-3.5 shrink-0" />
					<span>Switching restarts the CLI. History is kept.</span>
				</p>
			)}

			<Section title="Agent" disabled={agentLocked}>
				{agentChoices.map(({ type, info }) => (
					<ChoiceRow
						key={type}
						group={`${groupId}-agent`}
						value={type}
						label={
							<>
								<info.icon className="size-3.5" aria-hidden="true" />
								{info.label}
							</>
						}
						description={info.description}
						selected={agentType === type}
						onSelect={() => handleSelectAgent(type)}
					/>
				))}
			</Section>
			{/* Spelled out rather than left in a `title` tooltip, which a finger
			    can never reach — and kept outside the fieldset, because the
			    `opacity-50` that dims the controls it explains would take this
			    line to roughly 1.6:1 against the panel and undo the move. The
			    fieldset dims what is unusable; the reason has to stay readable. */}
			{isSessionActivated && (
				<p className="px-3 pt-1 text-xs text-th-text-muted">
					Agent is locked once the session starts
				</p>
			)}

			<Section title="Model" disabled={disabled}>
				{optionsError && (
					<p className="px-3 py-2 text-xs text-th-error">
						Couldn't load the engine options: {optionsError}
					</p>
				)}
				{/* A list that already arrived is still shown next to the error of
				    a later re-fetch. When none ever arrived the rows are still
				    drawn, because Auto is this layer's own constant and the
				    session's current model is already known: the fetch is not
				    retried until the socket reconnects, and without them someone
				    whose list failed could not even put the session back on Auto.
				    The error above them is what says the rest is missing. */}
				{models || optionsError ? (
					modelChoices.map((choice) => (
						<ChoiceRow
							key={choice.id}
							group={`${groupId}-model`}
							value={choice.id}
							label={choice.label}
							description={choice.description}
							selected={choice.id === model}
							onSelect={() => handleSelectModel(choice.id)}
						/>
					))
				) : (
					<p className="px-3 py-2 text-xs text-th-text-muted">
						Loading models…
					</p>
				)}
			</Section>

			{effortsAnswered &&
				(effortUnavailable ? (
					// Not `disabled`: there is no control here to dim, and the
					// `opacity-50` would take the one line that explains the absence
					// to roughly 1.6:1 against the panel.
					<Section title="Effort">
						<p className="px-3 py-2 text-xs text-th-text-muted">
							{agentInfo.label} has no effort setting.
						</p>
					</Section>
				) : (
					<Section title="Effort" disabled={disabled}>
						{effortChoices.map((choice) => (
							<ChoiceRow
								key={choice.id}
								group={`${groupId}-effort`}
								value={choice.id}
								label={choice.label}
								description={choice.description}
								selected={choice.id === effort}
								onSelect={() => handleSelectEffort(choice.id)}
							/>
						))}
					</Section>
				))}
		</>
	);
}

export default EngineSections;
