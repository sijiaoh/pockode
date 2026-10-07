import { useState } from "react";
import { useGlobalEngine } from "../../../hooks/useGlobalEngine";
import { useGlobalSettingsStatus } from "../../../hooks/useGlobalSettingsStatus";
import { AUTO_ID } from "../../../lib/agentOptions";
import { getSessionModeInfo, SESSION_MODES } from "../../../lib/sessionMode";
import { useSettingsStore } from "../../../lib/settingsStore";
import { useWSStore } from "../../../lib/wsStore";
import type { SessionMode } from "../../../types/message";
import type { AgentType } from "../../../types/settings";
import EngineField from "../../ui/EngineField";
import SettingsLoadError from "../../ui/SettingsLoadError";
import ToggleGroup from "../../ui/ToggleGroup";

export default function SessionSection() {
	const { engine } = useGlobalEngine();
	const { valueState } = useGlobalSettingsStatus();
	const defaultMode = useSettingsStore(
		(s) => s.settings?.default_mode ?? "default",
	);
	const updateSettings = useWSStore((s) => s.actions.updateSettings);
	const [modeError, setModeError] = useState<string | null>(null);

	// The Engine field above reports its own failures; this toggle applies
	// instantly and has nowhere else to say that the write was refused.
	const selectMode = (mode: SessionMode) => {
		setModeError(null);
		updateSettings({ default_mode: mode }).catch((err: unknown) => {
			setModeError(err instanceof Error ? err.message : String(err));
		});
	};

	return (
		<div className="space-y-4">
			{/* One line for both fields: they wait on one snapshot, and one failure
			    said twice would read as two. */}
			<SettingsLoadError />
			<div className="space-y-1.5">
				<EngineField
					agentType={engine.agentType}
					model={engine.model}
					effort={engine.effort}
					valueState={valueState}
					// The model and effort go with the agent: both are picked from its own
					// list, and the server judges the three as one and refuses a leftover
					// rather than quietly dropping it.
					onSelectAgent={(type) =>
						updateSettings({
							default_agent_type: type as AgentType,
							default_model: AUTO_ID,
							default_effort: AUTO_ID,
						})
					}
					onSelectModel={(id) => updateSettings({ default_model: id })}
					onSelectEffort={(id) => updateSettings({ default_effort: id })}
				/>
				<p className="text-xs text-th-text-muted">
					New sessions start with this engine. An agent role on another agent
					uses its own.
				</p>
			</div>
			<ToggleGroup<SessionMode>
				label="Mode"
				items={SESSION_MODES}
				selected={defaultMode}
				onSelect={selectMode}
				getInfo={(mode) => getSessionModeInfo(mode, engine.agentType)}
				hint={getSessionModeInfo(defaultMode, engine.agentType).description}
				error={modeError}
				valueState={valueState}
			/>
		</div>
	);
}
