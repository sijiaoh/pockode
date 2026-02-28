import { SESSION_MODE_INFO, SESSION_MODES } from "../../../lib/sessionMode";
import { useSettingsStore } from "../../../lib/settingsStore";
import { useWSStore } from "../../../lib/wsStore";
import type { SessionMode } from "../../../types/message";

export default function SessionSection() {
	const defaultMode = useSettingsStore(
		(s) => s.settings?.default_mode ?? "default",
	);
	const updateSettings = useWSStore((s) => s.actions.updateSettings);

	const handleSelect = (mode: SessionMode) => {
		updateSettings({ default_mode: mode });
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply toggle group
		<div
			role="group"
			aria-label="Default session mode"
			className="flex gap-1 rounded-lg bg-th-bg-secondary p-1"
		>
			{SESSION_MODES.map((mode) => {
				const info = SESSION_MODE_INFO[mode];
				const isSelected = defaultMode === mode;
				return (
					<button
						key={mode}
						type="button"
						onClick={() => handleSelect(mode)}
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
