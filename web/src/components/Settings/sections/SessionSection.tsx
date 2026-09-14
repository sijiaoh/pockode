import { useState } from "react";
import { useGlobalEngine } from "../../../hooks/useGlobalEngine";
import { useGlobalSettingsStatus } from "../../../hooks/useGlobalSettingsStatus";
import { AUTO_ID } from "../../../lib/agentOptions";
import { getSessionModeInfo, SESSION_MODES } from "../../../lib/sessionMode";
import { useSettingsStore } from "../../../lib/settingsStore";
import { type ValueState, waitingLabel } from "../../../lib/valueState";
import { useWSStore } from "../../../lib/wsStore";
import type { SessionMode } from "../../../types/message";
import type { AgentType } from "../../../types/settings";
import EngineField from "../../ui/EngineField";
import SettingsLoadError from "../../ui/SettingsLoadError";
import Skeleton from "../../ui/Skeleton";

function ToggleGroup<T extends string>({
	label,
	items,
	selected,
	onSelect,
	getInfo,
	hint,
	error,
	valueState = "known",
}: {
	label: string;
	items: readonly T[];
	selected: T;
	onSelect: (value: T) => void;
	getInfo: (value: T) => {
		label: string;
		icon: React.ComponentType<{ className?: string }>;
	};
	hint?: string;
	error?: string | null;
	/**
	 * Whether `selected` is the stored value. Which segment is lit *is* the value
	 * here, so anything but `known` replaces the whole row: three segments with
	 * none lit would claim nothing is selected, and would not look like waiting.
	 * The hint goes with it, being derived from the same value.
	 */
	valueState?: ValueState;
}) {
	const hasValue = valueState === "known";

	return (
		<div className="space-y-1.5">
			{/* Uppercase, as the Engine field beside it labels itself: the two are
			    fields of one section and a label style each would read as two. */}
			<p className="text-xs font-medium uppercase text-th-text-muted">
				{label}
			</p>
			{hasValue ? (
				// biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply toggle group
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
			) : (
				// biome-ignore lint/a11y/useSemanticElements: the group the segments would form, kept so the row does not resize when they arrive
				<div
					role="group"
					aria-label={waitingLabel(label, valueState)}
					aria-busy={valueState === "pending"}
					className="flex gap-1 rounded-lg bg-th-bg-secondary p-1"
				>
					<Skeleton
						className="h-11 flex-1 rounded-md"
						animated={valueState === "pending"}
					/>
				</div>
			)}
			{hasValue
				? hint && (
						<p className="whitespace-pre-line text-xs text-th-text-muted">
							{hint}
						</p>
					)
				: hint !== undefined && (
						<Skeleton
							className="h-3 w-2/3 rounded"
							animated={valueState === "pending"}
						/>
					)}
			{error && (
				<p className="text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

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
