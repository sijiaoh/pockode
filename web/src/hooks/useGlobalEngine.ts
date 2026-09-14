import { AUTO_ID } from "../lib/agentOptions";
import { DEFAULT_AGENT_TYPE } from "../lib/agentType";
import { useSettingsStore } from "../lib/settingsStore";
import type { AgentType } from "../types/settings";
import { useGlobalSettingsStatus } from "./useGlobalSettingsStatus";

export interface GlobalEngine {
	agentType: AgentType;
	model: string;
	effort: string;
}

/**
 * The global default engine, with every empty value resolved the way the server
 * resolves it (`settings.Settings.Engine`): an unset agent type is the built-in
 * default agent, because that is the agent these sessions really start on and the
 * agent the default model is judged against.
 *
 * `loaded` is a separate answer from the engine itself, because those resolved
 * defaults are only honest once there is a snapshot to resolve: until one lands
 * the Settings page draws placeholders rather than the row, and a caller that
 * reports what another engine *inherits* must not name a value it has not been
 * told yet. `useGlobalSettingsStatus` gives the fuller answer — whether the
 * snapshot is still on its way or is not coming at all.
 */
export function useGlobalEngine(): { engine: GlobalEngine; loaded: boolean } {
	const { valueState } = useGlobalSettingsStatus();
	// Field by field, not the whole object: the store replaces `settings` on every
	// change, so a single selector would re-render these panels for a worktree
	// directory edit.
	const agentType = useSettingsStore(
		(s) => s.settings?.default_agent_type || DEFAULT_AGENT_TYPE,
	);
	const model = useSettingsStore((s) => s.settings?.default_model ?? AUTO_ID);
	const effort = useSettingsStore((s) => s.settings?.default_effort ?? AUTO_ID);

	return {
		engine: { agentType, model, effort },
		loaded: valueState === "known",
	};
}
