import { useId } from "react";
import { AUTO_ID } from "../../../lib/agentOptions";
import { AGENT_TYPE_INFO } from "../../../lib/agentType";
import { useSettingsStore } from "../../../lib/settingsStore";
import type { ValueState } from "../../../lib/valueState";
import { useWSStore } from "../../../lib/wsStore";
import type { PermissionReviewerEngine } from "../../../types/settings";
import EngineField from "../../ui/EngineField";

interface Props {
	valueState: ValueState;
}

/**
 * The engine unattended sessions' permission requests are reviewed on. A
 * reviewer runs on its main session's agent, and only Claude has one
 * (`hasPermissionReviewer`), so this is Claude's engine and no agent is offered
 * (docs/unattended-mode-ui.md §7).
 */
export default function PermissionReviewerField({ valueState }: Props) {
	const headingId = useId();
	const updateSettings = useWSStore((s) => s.actions.updateSettings);
	// Field by field, as `useGlobalEngine` reads the defaults: the store replaces
	// `settings` on every change.
	const model = useSettingsStore(
		(s) => s.settings?.permission_reviewer?.claude?.model ?? AUTO_ID,
	);
	const effort = useSettingsStore(
		(s) => s.settings?.permission_reviewer?.claude?.effort ?? AUTO_ID,
	);

	// `settings.update` replaces the whole object, so the other field goes out
	// with every change. Read at the time of the change, not of the render: a
	// write to one field must not send back what the other showed before its own
	// write landed.
	const update = (change: Partial<PermissionReviewerEngine>) => {
		const current =
			useSettingsStore.getState().settings?.permission_reviewer?.claude;
		return updateSettings({
			permission_reviewer: { claude: { ...current, ...change } },
		});
	};

	return (
		// `min-w-0`: a fieldset is min-content wide by default, which would stop
		// the row's summary from truncating and push it off a narrow screen.
		<fieldset aria-labelledby={headingId} className="min-w-0 space-y-1.5">
			<h3
				id={headingId}
				className="mb-1 text-xs font-medium uppercase text-th-text-muted"
			>
				Permission reviewer
			</h3>
			<EngineField
				agentFixed
				agentType="claude"
				model={model}
				effort={effort}
				valueState={valueState}
				label={`${AGENT_TYPE_INFO.claude.label} permission reviewer`}
				hideHeading
				onSelectModel={(id) => update({ model: id })}
				onSelectEffort={(id) => update({ effort: id })}
			/>
			<p className="text-xs text-th-text-muted">
				Unattended Claude sessions' permission requests are reviewed on this.
				Auto lets the CLI decide. Codex never raises a permission request under
				YOLO, so its Unattended sessions never reach a review.
			</p>
		</fieldset>
	);
}
