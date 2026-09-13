import { useIsExpanded } from "@pockode/shared";
import { ChevronDown, CircleHelp } from "lucide-react";
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
import {
	AGENT_TYPE_INFO,
	AGENT_TYPES,
	type AgentTypeInfo,
} from "../../lib/agentType";
import type { AgentType } from "../../types/settings";
import { ChoiceRow, Section } from "./ChoiceList";
import ResponsivePanel from "./ResponsivePanel";

/**
 * The empty agent type. Not called Auto, though the empty model and effort are:
 * this one points at a value the user set themselves in Settings and can go
 * read, while Auto hands the decision to the CLI. The three sit in one panel, so
 * one word for both would say they mean the same thing.
 */
const FOLLOW_SETTINGS_ID = "";
const FOLLOW_SETTINGS_LABEL = "Follow settings";
const FOLLOW_SETTINGS_DESCRIPTION = "Use the default engine from Settings";

/** Which section's update failed, so the reason lands under the rows that caused it. */
type ErrorSection = "agent" | "model" | "effort";

interface Props {
	/** Undefined when nobody has picked one, which only an agent role may be. */
	agentType: AgentType | undefined;
	model: string;
	effort: string;
	/**
	 * Whether the Agent section offers a row that leaves the agent unset. Only an
	 * agent role has somewhere to defer to; the global defaults are the bottom of
	 * that chain and must name an agent themselves.
	 */
	allowFollowSettings?: boolean;
	/**
	 * What Auto means under this caller. The global defaults hand the decision to
	 * the CLI, while an agent role on the global agent has its empty values filled
	 * in from Settings instead — the description is the only place that shows.
	 */
	autoModelDescription?: string;
	autoEffortDescription?: string;
	/**
	 * A selection rejected by the server rejects the whole field, so these throw
	 * rather than report. Which fields go on the wire is the caller's business:
	 * an agent role sends the one that changed and lets the server clear the rest,
	 * while the global defaults are replaced as a whole and must clear the model
	 * and effort themselves.
	 */
	onSelectAgent: (agentType: string) => Promise<void>;
	onSelectModel: (model: string) => Promise<void>;
	onSelectEffort: (effort: string) => Promise<void>;
}

/** An agent id this build has no entry for, shown as itself. */
const unknownAgentInfo = (id: string): AgentTypeInfo => ({
	label: id,
	description: "Not a known agent on this server",
	icon: CircleHelp,
});

/**
 * An engine — agent, model and effort — behind a collapsed summary row, in the
 * same three-section panel the chat uses. Shared by the agent role page and the
 * global defaults in Settings, which differ only in what they send and in what
 * an empty model means; both are controlled, so the selected dot follows the
 * server's answer rather than the click.
 *
 * Not `Chat/EngineSelector` itself: that one is shaped around a resolved,
 * possibly running session — a locked agent after activation, a CLI that
 * restarts on a switch — and is replaceable through `chatUIRegistry`. Neither a
 * role nor a setting touches a session that already exists.
 */
function EngineField({
	agentType,
	model,
	effort,
	allowFollowSettings = false,
	autoModelDescription = AUTO_MODEL_DESCRIPTION,
	autoEffortDescription = AUTO_EFFORT_DESCRIPTION,
	onSelectAgent,
	onSelectModel,
	onSelectEffort,
}: Props) {
	const [isOpen, setIsOpen] = useState(false);
	const [error, setError] = useState<{
		section: ErrorSection;
		message: string;
	} | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	// Radio `name` is document-wide; scope it so a second selector on the page
	// cannot steal this one's selection.
	const groupId = useId();
	const isExpanded = useIsExpanded();

	const models = useModelsForAgent(agentType);
	const efforts = useEffortsForAgent(agentType);
	const optionsError = useAgentOptionsStore((s) => s.error);
	// Whether the fetch answered, which is not the same question as whether this
	// agent has a list: the server drops an agent it no longer offers out of the
	// map entirely, and a field pinned to that agent would otherwise wait on a
	// list that is never coming — with no way left to put its model back on Auto.
	const optionsFetched = useAgentOptionsStore((s) => s.models !== null);

	// An agent id this build has no entry for keeps its own name and a neutral
	// icon. Not falling back to Claude the way the session chip does: there the
	// only such row is the current, locked one, while this field can be set to
	// anything the server offers, and drawing Codex as Claude would be a lie
	// about a value the user is here to edit.
	const agentInfo: AgentTypeInfo | undefined = agentType
		? (AGENT_TYPE_INFO[agentType] ?? unknownAgentInfo(agentType))
		: undefined;

	const modelChoices = buildChoices(models, model, autoModelDescription);
	const effortChoices = buildChoices(efforts, effort, autoEffortDescription);
	const modelLabel = getOptionLabel(models, model);
	// Auto has no value to report: whichever level the CLI then picks is its own
	// business, and an agent with no effort setting has nothing to name.
	const effortLabel =
		effort === AUTO_ID ? null : getOptionLabel(efforts, effort);

	// Which list applies is a question about an agent. Without one there is no
	// answer, and the server refuses to store a model in that state anyway.
	const engineUnpicked = agentType === undefined;

	// A failed fetch counts as an answer: Auto and the current value are this
	// layer's to offer regardless, and the fetch is not retried until the socket
	// reconnects. With no agent picked there is nothing to wait for either —
	// both sections are dimmed and offer only Auto.
	const optionsAnswered =
		engineUnpicked || optionsFetched || optionsError !== null;
	const effortsAnswered =
		engineUnpicked || efforts !== undefined || optionsError !== null;
	// An agent the server left out of the map has no effort setting. Said in
	// words rather than by hiding the section, which at the bottom of a panel is
	// indistinguishable from still loading — except while the field still holds a
	// level from before the server dropped them, which has to stay clearable.
	const effortUnavailable = efforts?.length === 0 && effort === AUTO_ID;

	const agentChoices: { id: string; info: AgentTypeInfo }[] = AGENT_TYPES.map(
		(type) => ({ id: type, info: AGENT_TYPE_INFO[type] }),
	);
	// Listed as a row of its own, the way a retired model id is: without it the
	// section would look like nothing is selected.
	if (agentType && !AGENT_TYPE_INFO[agentType]) {
		agentChoices.unshift({ id: agentType, info: unknownAgentInfo(agentType) });
	}

	// A failure names the choice that caused it, and the panel is the only place
	// that context exists. Reopening it must not re-report an error about
	// something the user has since stopped looking at.
	const setPanelOpen = useCallback((open: boolean) => {
		setIsOpen(open);
		if (!open) setError(null);
	}, []);

	const handleClose = useCallback(() => setPanelOpen(false), [setPanelOpen]);

	// The panel stays open either way. A radio group selects as the arrow keys
	// move through it, so closing on selection would leave a keyboard user able
	// to reach only the option next to the current one — and seeing the dot move,
	// or the model list swap to the new agent's, is the confirmation. On failure
	// the reason goes under the section that was touched: unlike the chat's
	// selector, the pages this field sits on have no channel outside the panel to
	// report it on.
	const applyChoice = async (
		section: ErrorSection,
		change: () => Promise<void>,
	) => {
		setError(null);
		try {
			await change();
		} catch (err) {
			setError({
				section,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const errorFor = (section: ErrorSection) =>
		error?.section === section ? (
			<p className="px-3 pt-1 pb-2 text-xs text-th-error" role="alert">
				{error.message}
			</p>
		) : null;

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium uppercase text-th-text-muted">
				Engine
			</h3>
			<div className="relative">
				<button
					ref={triggerRef}
					type="button"
					onClick={() => setPanelOpen(!isOpen)}
					aria-haspopup="dialog"
					aria-expanded={isOpen}
					aria-label={
						agentInfo
							? `Engine: ${agentInfo.label}, ${modelLabel}${
									effortLabel ? `, ${effortLabel} effort` : ""
								}`
							: `Engine: ${FOLLOW_SETTINGS_LABEL}`
					}
					className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-th-border bg-th-bg-secondary px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent hover:border-th-border-focus"
				>
					{agentInfo ? (
						<>
							<agentInfo.icon
								className="size-4 shrink-0 text-th-text-secondary"
								aria-hidden="true"
							/>
							{/* The row has the whole page width, so nothing is budgeted away
							    the way the action-bar chip budgets it — but an agent or model
							    id this build has never heard of has no length limit at all. */}
							<span className="min-w-0 flex-1 truncate text-sm text-th-text-primary">
								{agentInfo.label} · {modelLabel}
								{effortLabel && <> · {effortLabel}</>}
							</span>
						</>
					) : (
						<span className="min-w-0 flex-1 truncate text-sm text-th-text-muted">
							{FOLLOW_SETTINGS_LABEL}
						</span>
					)}
					<ChevronDown
						className="size-4 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
				</button>

				<ResponsivePanel
					isOpen={isOpen}
					onClose={handleClose}
					title="Engine"
					triggerRef={triggerRef}
					isExpanded={isExpanded}
					desktopPosition="stretch"
					// Three sections do not fit the default heights on any phone.
					mobileMaxHeight="80dvh"
					desktopMaxHeight="70vh"
				>
					<div className="overflow-y-auto pb-2">
						<Section title="Agent">
							{allowFollowSettings && (
								<ChoiceRow
									group={`${groupId}-agent`}
									value={FOLLOW_SETTINGS_ID}
									label={FOLLOW_SETTINGS_LABEL}
									description={FOLLOW_SETTINGS_DESCRIPTION}
									selected={engineUnpicked}
									onSelect={() =>
										applyChoice("agent", () =>
											onSelectAgent(FOLLOW_SETTINGS_ID),
										)
									}
								/>
							)}
							{agentChoices.map(({ id, info }) => (
								<ChoiceRow
									key={id}
									group={`${groupId}-agent`}
									value={id}
									label={
										<>
											<info.icon className="size-3.5" aria-hidden="true" />
											{info.label}
										</>
									}
									description={info.description}
									selected={agentType === id}
									onSelect={() => applyChoice("agent", () => onSelectAgent(id))}
								/>
							))}
						</Section>
						{errorFor("agent")}

						<Section title="Model" disabled={engineUnpicked}>
							{optionsError && !engineUnpicked && (
								<p className="px-3 py-2 text-xs text-th-error">
									Couldn't load the engine options: {optionsError}
								</p>
							)}
							{/* The rows are drawn even when no list ever arrived: Auto is
							    this layer's own constant and the current model is already
							    known, and without them someone whose fetch failed could not
							    even put the model back on Auto. */}
							{optionsAnswered ? (
								modelChoices.map((choice) => (
									<ChoiceRow
										key={choice.id}
										group={`${groupId}-model`}
										value={choice.id}
										label={choice.label}
										description={choice.description}
										selected={choice.id === model}
										onSelect={() =>
											applyChoice("model", () => onSelectModel(choice.id))
										}
									/>
								))
							) : (
								<p className="px-3 py-2 text-xs text-th-text-muted">
									Loading models…
								</p>
							)}
						</Section>
						{errorFor("model")}

						{effortsAnswered &&
							(effortUnavailable ? (
								// Not `disabled`: there is no control here to dim, and the
								// `opacity-50` would take the one line that explains the
								// absence to roughly 1.6:1 against the panel.
								<Section title="Effort">
									<p className="px-3 py-2 text-xs text-th-text-muted">
										{agentInfo?.label} has no effort setting.
									</p>
								</Section>
							) : (
								<Section title="Effort" disabled={engineUnpicked}>
									{effortChoices.map((choice) => (
										<ChoiceRow
											key={choice.id}
											group={`${groupId}-effort`}
											value={choice.id}
											label={choice.label}
											description={choice.description}
											selected={choice.id === effort}
											onSelect={() =>
												applyChoice("effort", () => onSelectEffort(choice.id))
											}
										/>
									))}
								</Section>
							))}
						{errorFor("effort")}

						{/* Outside both fieldsets: the `opacity-50` that dims the rows this
						    line explains would take it to roughly 1.6:1 against the panel
						    and undo the move. One line rather than one per section — they
						    are dimmed together, by the same missing answer. */}
						{engineUnpicked && (
							<p className="px-3 pt-1 text-xs text-th-text-muted">
								Pick an agent to choose its model and effort.
							</p>
						)}
					</div>
				</ResponsivePanel>
			</div>
		</div>
	);
}

export default EngineField;
