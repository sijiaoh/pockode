import { useIsExpanded } from "@pockode/shared";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
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
import { AGENT_TYPE_INFO, AGENT_TYPES } from "../../lib/agentType";
import type { AgentOption } from "../../types/message";
import type { AgentType } from "../../types/settings";
import { ChoiceRow, Section } from "../ui/ChoiceList";
import ResponsivePanel from "../ui/ResponsivePanel";

interface Props {
	agentType: AgentType;
	/** Empty means Auto — the CLI picks. */
	model: string;
	/** Empty means Auto — the CLI keeps its own default. */
	effort: string;
	onAgentTypeChange: (type: AgentType) => Promise<void>;
	onModelChange: (model: string) => Promise<void>;
	onEffortChange: (effort: string) => Promise<void>;
	/**
	 * False while the session has yet to describe itself — it is not resolved
	 * yet, or its metadata has not arrived — so `model` and `effort` are
	 * placeholders and there is no value to name.
	 */
	isSessionResolved?: boolean;
	/** The agent has answered here: its choice is locked and a switch restarts the CLI. */
	isSessionActivated?: boolean;
	disabled?: boolean;
}

/**
 * Agent, model and effort in one control: both lists are decided by the agent,
 * so they are three levels of one choice rather than three choices. The chip
 * carries the agent as its icon and the model as its text — a model cannot be
 * expressed as an icon, and there is no room in the action bar for a second
 * button wide enough to hold a word.
 */
function EngineSelector({
	agentType,
	model,
	effort,
	onAgentTypeChange,
	onModelChange,
	onEffortChange,
	isSessionResolved = true,
	isSessionActivated = false,
	disabled = false,
}: Props) {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	// Radio `name` is document-wide; scope it so a second selector on the page
	// cannot steal this one's selection.
	const groupId = useId();
	const isExpanded = useIsExpanded();

	const models = useModelsForAgent(agentType);
	const efforts = useEffortsForAgent(agentType);
	const optionsError = useAgentOptionsStore((s) => s.error);

	const agentInfo = AGENT_TYPE_INFO[agentType] ?? AGENT_TYPE_INFO.claude;
	const modelLabel = getOptionLabel(models, model);
	const modelChoices = buildChoices(models, model, AUTO_MODEL_DESCRIPTION);
	const effortChoices = buildChoices(efforts, effort, AUTO_EFFORT_DESCRIPTION);
	// Auto has no value to report on the chip: the effort the CLI then picks is
	// its own business, and for an agent with no effort setting at all there is
	// nothing to name.
	const effortLabel =
		effort === AUTO_ID ? null : getOptionLabel(efforts, effort);

	// Auto needs no list to be named, and a list that failed to load is never
	// coming — anything else would show the raw id for a moment and then correct
	// itself, or hang on a skeleton forever. Both values have to be nameable
	// before either is shown: they are one string on the chip, so naming one of
	// them early is the same flash.
	const canName = (id: string, options: AgentOption[] | undefined) =>
		id === AUTO_ID || options !== undefined || optionsError !== null;
	const hasLabel =
		isSessionResolved && canName(model, models) && canName(effort, efforts);

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

	const handleClose = useCallback(() => setIsOpen(false), []);

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
			setIsOpen(false);
		}
	};

	const handleSelectAgent = (type: AgentType) =>
		applyChoice(() => onAgentTypeChange(type));

	const handleSelectModel = (id: string) =>
		applyChoice(() => onModelChange(id));

	const handleSelectEffort = (id: string) =>
		applyChoice(() => onEffortChange(id));

	return (
		<div className="relative">
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setIsOpen((v) => !v)}
				disabled={disabled}
				title={disabled ? "Wait for the current turn to finish" : undefined}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				// The values, not the glyphs: the model name is truncated on screen
				// and the effort suffix is the first thing to go, but a label that
				// reported only what fits would report the wrong thing.
				aria-label={
					isSessionResolved
						? `Engine: ${agentInfo.label}, ${hasLabel ? modelLabel : "loading"}${
								hasLabel && effortLabel ? `, ${effortLabel} effort` : ""
							}`
						: "Engine: loading"
				}
				className="group flex h-9 min-w-0 items-center gap-1.5 rounded border border-th-border bg-th-bg-tertiary pl-2 pr-1.5 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 hover:border-th-border-focus disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11"
			>
				{/* The agent is one of the session's settings, so it waits like the
				    rest: `agentInfo` falls back to Claude, and asserting that would
				    put Claude's mark on a Codex session for a round trip. Gated on
				    `isSessionResolved` rather than `hasLabel` — that one also drops
				    while only the model list is still loading, by which point the
				    agent is known and its icon is the one true thing on the chip. */}
				{isSessionResolved ? (
					<agentInfo.icon
						className="size-4 shrink-0 text-th-text-secondary group-hover:text-th-text-primary"
						aria-hidden="true"
					/>
				) : (
					<span
						className="size-4 shrink-0 animate-pulse rounded-full bg-th-text-muted/20"
						aria-hidden="true"
					/>
				)}
				{hasLabel ? (
					// The effort suffix shares the model's truncation budget instead of
					// being held out of it: on a 360px viewport the action bar has
					// barely room for one of them, and the model is the session's
					// identity while the effort is a setting.
					<span className="max-w-[88px] truncate text-xs text-th-text-primary sm:max-w-[140px]">
						{modelLabel}
						{effortLabel && (
							<span className="text-th-text-muted"> · {effortLabel}</span>
						)}
					</span>
				) : (
					// Not "Auto": the real value is one round trip away, and showing it
					// early would flash a model the session may not be set to.
					<span
						className="h-3 w-10 animate-pulse rounded bg-th-text-muted/20"
						aria-hidden="true"
					/>
				)}
				<ChevronDown
					className="size-3.5 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
			</button>

			<ResponsivePanel
				isOpen={isOpen}
				onClose={handleClose}
				title="Engine"
				triggerRef={triggerRef}
				isExpanded={isExpanded}
				desktopPosition="left"
				desktopPlacement="above"
				desktopWidth="w-72"
				// Three sections do not fit the default heights on any phone. Taller
				// than the other panels, still short enough to read as a sheet with the
				// conversation behind it.
				mobileMaxHeight="80dvh"
				desktopMaxHeight="70vh"
			>
				<div className="overflow-y-auto pb-2">
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
				</div>
			</ResponsivePanel>
		</div>
	);
}

export default EngineSelector;
