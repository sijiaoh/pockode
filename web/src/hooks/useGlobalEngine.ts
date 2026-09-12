import { AUTO_ID } from "../lib/agentOptions";
import { DEFAULT_AGENT_TYPE } from "../lib/agentType";
import { useSettingsStore } from "../lib/settingsStore";
import type { AgentType } from "../types/settings";

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
 * `loaded` is a separate answer from the engine itself. The Settings page has to
 * draw a row before the subscription arrives and the resolved defaults are the
 * honest thing to show there, while a caller that reports what another engine
 * *inherits* must not name a value it has not been told yet.
 */
export function useGlobalEngine(): { engine: GlobalEngine; loaded: boolean } {
	// Field by field, not the whole object: the store replaces `settings` on every
	// change, so a single selector would re-render these panels for a worktree
	// directory edit.
	const loaded = useSettingsStore((s) => s.settings !== null);
	const agentType = useSettingsStore(
		(s) => s.settings?.default_agent_type || DEFAULT_AGENT_TYPE,
	);
	const model = useSettingsStore((s) => s.settings?.default_model ?? AUTO_ID);
	const effort = useSettingsStore((s) => s.settings?.default_effort ?? AUTO_ID);

	return { engine: { agentType, model, effort }, loaded };
}
