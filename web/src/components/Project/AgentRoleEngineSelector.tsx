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
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import type { AgentType } from "../../types/settings";
import { ChoiceRow, Section } from "../ui/ChoiceList";
import ResponsivePanel from "../ui/ResponsivePanel";

interface Props {
	role: AgentRole;
}

/**
 * The empty agent type. Not called Auto, though the empty model and effort are:
 * this one points at a value the user set themselves in Settings and can go
 * read, while Auto hands the decision to the CLI. The three sit in one panel, so
 * one word for both would say they mean the same thing.
 */
const FOLLOW_SETTINGS_ID = "";
const FOLLOW_SETTINGS_LABEL = "Follow settings";
const FOLLOW_SETTINGS_DESCRIPTION = "Use the default agent from Settings";

/** Which section's update failed, so the reason lands under the rows that caused it. */
type ErrorSection = "agent" | "model" | "effort";

/** An agent id this build has no entry for, shown as itself. */
const unknownAgentInfo = (id: string): AgentTypeInfo => ({
	label: id,
	description: "Not a known agent on this server",
	icon: CircleHelp,
});

/**
 * The engine a role starts its sessions with: agent, model and effort, in the
 * same three-section panel the chat uses, behind a collapsed summary row.
 *
 * Not `EngineSelector` itself: a role can leave the agent unset, which no
 * session can, and none of the things that selector is shaped around — a
 * resolved session, a locked agent after activation, a CLI that restarts on a
 * switch — exist here. Editing a role never touches a session already running.
 */
function AgentRoleEngineSelector({ role }: Props) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
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

	// `|| undefined`, not `??`: the server omits the field when unset, but an
	// empty string is the same "unset" on the wire and must not read as an agent.
	const agentType = role.agent_type || undefined;
	const model = role.model ?? AUTO_ID;
	const effort = role.effort ?? AUTO_ID;

	const models = useModelsForAgent(agentType);
	const efforts = useEffortsForAgent(agentType);
	const optionsError = useAgentOptionsStore((s) => s.error);
	// Whether the fetch answered, which is not the same question as whether this
	// agent has a list: the server drops an agent it no longer offers out of the
	// map entirely, and a role pinned to that agent would otherwise wait on a
	// list that is never coming — with no way left to put its model back on Auto.
	const optionsFetched = useAgentOptionsStore((s) => s.models !== null);

	// An agent id this build has no entry for keeps its own name and a neutral
	// icon. Not falling back to Claude the way the session chip does: there the
	// only such row is the current, locked one, while a role can be set to
	// anything the server offers, and drawing Codex as Claude would be a lie
	// about a value the user is here to edit.
	const agentInfo: AgentTypeInfo | undefined = agentType
		? (AGENT_TYPE_INFO[agentType] ?? unknownAgentInfo(agentType))
		: undefined;

	const modelChoices = buildChoices(models, model, AUTO_MODEL_DESCRIPTION);
	const effortChoices = buildChoices(efforts, effort, AUTO_EFFORT_DESCRIPTION);
	const modelLabel = getOptionLabel(models, model);
	// Auto has no value to report: whichever level the CLI then picks is its own
	// business, and an agent with no effort setting has nothing to name.
	const effortLabel =
		effort === AUTO_ID ? null : getOptionLabel(efforts, effort);

	// Which list applies is a question about an agent. Without one there is no
	// answer, and the server refuses to store a model in that state anyway.
	const engineUnpicked = agentType === undefined;

	// A failed fetch counts as an answer: Auto and the role's current value are
	// this layer's to offer regardless, and the fetch is not retried until the
	// socket reconnects. With no agent picked there is nothing to wait for
	// either — both sections are dimmed and offer only Auto.
	const optionsAnswered =
		engineUnpicked || optionsFetched || optionsError !== null;
	const effortsAnswered =
		engineUnpicked || efforts !== undefined || optionsError !== null;
	// An agent the server left out of the map has no effort setting. Said in
	// words rather than by hiding the section, which at the bottom of a panel is
	// indistinguishable from still loading — except while the role still holds a
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
	// selector, this page has no channel outside the panel to report it on.
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

	// Only the agent is sent when it changes: the server clears the model and the
	// effort along with it, since neither survives a move to another agent.
	const handleSelectAgent = (id: string) =>
		applyChoice("agent", () =>
			updateAgentRole({ id: role.id, agent_type: id as AgentType | "" }),
		);

	const handleSelectModel = (id: string) =>
		applyChoice("model", () => updateAgentRole({ id: role.id, model: id }));

	const handleSelectEffort = (id: string) =>
		applyChoice("effort", () => updateAgentRole({ id: role.id, effort: id }));

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
							<ChoiceRow
								group={`${groupId}-agent`}
								value={FOLLOW_SETTINGS_ID}
								label={FOLLOW_SETTINGS_LABEL}
								description={FOLLOW_SETTINGS_DESCRIPTION}
								selected={engineUnpicked}
								onSelect={() => handleSelectAgent(FOLLOW_SETTINGS_ID)}
							/>
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
									onSelect={() => handleSelectAgent(id)}
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
							    this layer's own constant and the role's current model is
							    already known, and without them someone whose fetch failed
							    could not even put the role back on Auto. */}
							{optionsAnswered ? (
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
											onSelect={() => handleSelectEffort(choice.id)}
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

export default AgentRoleEngineSelector;
