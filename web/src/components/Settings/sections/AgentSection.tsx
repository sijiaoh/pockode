import { AGENT_TYPE_INFO, AGENT_TYPES } from "../../../lib/agentType";
import { useSettingsStore } from "../../../lib/settingsStore";
import { useWSStore } from "../../../lib/wsStore";
import type { AgentType } from "../../../types/settings";

export default function AgentSection() {
	const agentType = useSettingsStore(
		(s) => s.settings?.default_agent_type ?? "claude",
	);
	const updateSettings = useWSStore((s) => s.actions.updateSettings);

	const handleSelect = (type: AgentType) => {
		updateSettings({ default_agent_type: type });
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply toggle group
		<div
			role="group"
			aria-label="Agent type"
			className="flex gap-1 rounded-lg bg-th-bg-secondary p-1"
		>
			{AGENT_TYPES.map((type_) => {
				const info = AGENT_TYPE_INFO[type_];
				const isSelected = agentType === type_;
				return (
					<button
						key={type_}
						type="button"
						onClick={() => handleSelect(type_)}
						aria-pressed={isSelected}
						className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
							isSelected
								? "bg-th-bg-tertiary text-th-text-primary shadow-sm"
								: "text-th-text-muted hover:text-th-text-secondary"
						}`}
					>
						<info.icon className="h-4 w-4" aria-hidden="true" />
						<span>{info.label}</span>
					</button>
				);
			})}
		</div>
	);
}
