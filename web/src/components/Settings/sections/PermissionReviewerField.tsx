import { useId } from "react";
import { AUTO_ID } from "../../../lib/agentOptions";
import { AGENT_TYPE_INFO, AGENT_TYPES } from "../../../lib/agentType";
import { useSettingsStore } from "../../../lib/settingsStore";
import type { ValueState } from "../../../lib/valueState";
import { useWSStore } from "../../../lib/wsStore";
import type {
	AgentType,
	PermissionReviewerEngine,
} from "../../../types/settings";
import EngineField from "../../ui/EngineField";

interface Props {
	valueState: ValueState;
}

/**
 * The engine unattended sessions' permission requests are reviewed on, one row
 * per agent: a reviewer runs on its main session's agent, so both apply at
 * once and neither is a choice between them (docs/unattended-mode-ui.md §7).
 */
export default function PermissionReviewerField({ valueState }: Props) {
	const headingId = useId();
	const updateSettings = useWSStore((s) => s.actions.updateSettings);

	// `settings.update` replaces the whole object, so the other agent's values go
	// out with every change. Read at the time of the change, not of the render:
	// a write to one row must not send back what the other row showed before its
	// own write landed.
	const update = (
		agentType: AgentType,
		change: Partial<PermissionReviewerEngine>,
	) => {
		const current =
			useSettingsStore.getState().settings?.permission_reviewer ?? {};
		return updateSettings({
			permission_reviewer: {
				...current,
				[agentType]: { ...current[agentType], ...change },
			},
		});
	};

	return (
		// `min-w-0`: a fieldset is min-content wide by default, which would stop
		// the rows' summaries from truncating and push them off a narrow screen.
		<fieldset aria-labelledby={headingId} className="min-w-0 space-y-1.5">
			<h3
				id={headingId}
				className="mb-1 text-xs font-medium uppercase text-th-text-muted"
			>
				Permission reviewer
			</h3>
			{AGENT_TYPES.map((agentType) => (
				<ReviewerRow
					key={agentType}
					agentType={agentType}
					valueState={valueState}
					onSelectModel={(model) => update(agentType, { model })}
					onSelectEffort={(effort) => update(agentType, { effort })}
				/>
			))}
			<p className="text-xs text-th-text-muted">
				Unattended sessions' permission requests are reviewed on these. Auto
				lets the CLI decide.
			</p>
		</fieldset>
	);
}

function ReviewerRow({
	agentType,
	valueState,
	onSelectModel,
	onSelectEffort,
}: {
	agentType: AgentType;
	valueState: ValueState;
	onSelectModel: (model: string) => Promise<void>;
	onSelectEffort: (effort: string) => Promise<void>;
}) {
	// Field by field, as `useGlobalEngine` reads the defaults: the store replaces
	// `settings` on every change.
	const model = useSettingsStore(
		(s) => s.settings?.permission_reviewer?.[agentType]?.model ?? AUTO_ID,
	);
	const effort = useSettingsStore(
		(s) => s.settings?.permission_reviewer?.[agentType]?.effort ?? AUTO_ID,
	);

	return (
		<EngineField
			agentFixed
			agentType={agentType}
			model={model}
			effort={effort}
			valueState={valueState}
			label={`${AGENT_TYPE_INFO[agentType].label} permission reviewer`}
			hideHeading
			onSelectModel={onSelectModel}
			onSelectEffort={onSelectEffort}
		/>
	);
}
