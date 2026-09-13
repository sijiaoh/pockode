import { useGlobalEngine } from "../../hooks/useGlobalEngine";
import {
	AUTO_ID,
	fromSettingsDescription,
	getOptionLabel,
} from "../../lib/agentOptions";
import {
	useEffortsForAgent,
	useModelsForAgent,
} from "../../lib/agentOptionsStore";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import type { AgentType } from "../../types/settings";
import EngineField from "../ui/EngineField";

interface Props {
	role: AgentRole;
}

/**
 * The engine a role starts its sessions with. Only the two things a role does
 * differently from the global defaults live here: it may leave the agent unset
 * to follow Settings, and an empty model or effort of its own is filled in from
 * Settings rather than left to the CLI — but only while the role stays on the
 * global agent, since values picked from another agent's list are not carried
 * across (`settings.Settings.ResolveEngine`).
 */
function AgentRoleEngineSelector({ role }: Props) {
	const updateAgentRole = useWSStore((s) => s.actions.updateAgentRole);
	const { engine: globalEngine, loaded: settingsLoaded } = useGlobalEngine();

	// `|| undefined`, not `??`: the server omits the field when unset, but an
	// empty string is the same "unset" on the wire and must not read as an agent.
	const agentType = role.agent_type || undefined;
	const model = role.model ?? AUTO_ID;
	const effort = role.effort ?? AUTO_ID;

	// Same agent, so the role's own lists are the ones the global values were
	// picked from too.
	const models = useModelsForAgent(agentType);
	const efforts = useEffortsForAgent(agentType);

	// Until the settings arrive there is nothing to name, and claiming a value
	// this role does not know yet would be worse than the generic description.
	const inheritsFromSettings =
		settingsLoaded &&
		agentType !== undefined &&
		agentType === globalEngine.agentType;

	// Only the agent is sent when it changes: the server clears the model and the
	// effort along with it, since neither survives a move to another agent.
	const handleSelectAgent = (id: string) =>
		updateAgentRole({ id: role.id, agent_type: id as AgentType | "" });

	return (
		<EngineField
			agentType={agentType}
			model={model}
			effort={effort}
			allowFollowSettings
			autoModelDescription={
				inheritsFromSettings
					? fromSettingsDescription(getOptionLabel(models, globalEngine.model))
					: undefined
			}
			autoEffortDescription={
				inheritsFromSettings
					? fromSettingsDescription(
							getOptionLabel(efforts, globalEngine.effort),
						)
					: undefined
			}
			onSelectAgent={handleSelectAgent}
			onSelectModel={(id) => updateAgentRole({ id: role.id, model: id })}
			onSelectEffort={(id) => updateAgentRole({ id: role.id, effort: id })}
		/>
	);
}

export default AgentRoleEngineSelector;
