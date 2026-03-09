import { AGENT_TYPE_INFO, AGENT_TYPES } from "../../../lib/agentType";
import { SESSION_MODE_INFO, SESSION_MODES } from "../../../lib/sessionMode";
import { useSettingsStore } from "../../../lib/settingsStore";
import { useWSStore } from "../../../lib/wsStore";
import type { SessionMode } from "../../../types/message";
import type { AgentType } from "../../../types/settings";

function ToggleGroup<T extends string>({
	label,
	items,
	selected,
	onSelect,
	getInfo,
}: {
	label: string;
	items: readonly T[];
	selected: T;
	onSelect: (value: T) => void;
	getInfo: (value: T) => {
		label: string;
		icon: React.ComponentType<{ className?: string }>;
	};
}) {
	return (
		<div className="space-y-1.5">
			<p className="text-xs font-medium text-th-text-muted">{label}</p>
			{/* biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply toggle group */}
			<div
				role="group"
				aria-label={label}
				className="flex gap-1 rounded-lg bg-th-bg-secondary p-1"
			>
				{items.map((item) => {
					const info = getInfo(item);
					const isSelected = selected === item;
					return (
						<button
							key={item}
							type="button"
							onClick={() => onSelect(item)}
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
		</div>
	);
}

export default function SessionSection() {
	const agentType = useSettingsStore(
		(s) => s.settings?.default_agent_type ?? "claude",
	);
	const defaultMode = useSettingsStore(
		(s) => s.settings?.default_mode ?? "default",
	);
	const updateSettings = useWSStore((s) => s.actions.updateSettings);

	return (
		<div className="space-y-4">
			<ToggleGroup<AgentType>
				label="Agent"
				items={AGENT_TYPES}
				selected={agentType}
				onSelect={(type) => updateSettings({ default_agent_type: type })}
				getInfo={(type) => AGENT_TYPE_INFO[type]}
			/>
			<ToggleGroup<SessionMode>
				label="Mode"
				items={SESSION_MODES}
				selected={defaultMode}
				onSelect={(mode) => updateSettings({ default_mode: mode })}
				getInfo={(mode) => SESSION_MODE_INFO[mode]}
			/>
		</div>
	);
}
