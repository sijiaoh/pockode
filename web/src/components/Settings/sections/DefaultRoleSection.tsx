import { Check } from "lucide-react";
import { useAgentRoleStore } from "../../../lib/agentRoleStore";
import { useSettingsStore } from "../../../lib/settingsStore";
import { useWSStore } from "../../../lib/wsStore";

export default function DefaultRoleSection() {
	const roles = useAgentRoleStore((s) => s.roles);
	const defaultRoleId = useSettingsStore(
		(s) => s.settings?.default_agent_role_id ?? "",
	);
	const updateSettings = useWSStore((s) => s.actions.updateSettings);

	const handleSelect = (roleId: string) => {
		updateSettings({ default_agent_role_id: roleId });
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply selection
		<div
			role="group"
			aria-label="Default role selection"
			className="grid grid-cols-1 gap-2"
		>
			{roles.map((role) => {
				const isSelected = defaultRoleId === role.id;
				return (
					<button
						key={role.id}
						type="button"
						onClick={() => handleSelect(role.id)}
						aria-pressed={isSelected}
						className={`flex min-h-12 items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-[0.98] ${
							isSelected
								? "border-th-accent text-th-text-primary ring-1 ring-th-accent"
								: "border-th-border text-th-text-primary hover:border-th-text-muted"
						}`}
					>
						<span>{role.name}</span>
						{isSelected && (
							<Check
								className="h-4 w-4 text-th-accent"
								strokeWidth={2.5}
								aria-hidden="true"
							/>
						)}
					</button>
				);
			})}
			<button
				type="button"
				onClick={() => handleSelect("")}
				aria-pressed={!defaultRoleId}
				className={`flex min-h-12 items-center justify-between rounded-lg border border-dashed px-3 py-2 text-left text-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-[0.98] ${
					!defaultRoleId
						? "border-th-accent text-th-text-primary ring-1 ring-th-accent"
						: "border-th-border text-th-text-muted hover:border-th-text-muted"
				}`}
			>
				<span>None (always ask)</span>
				{!defaultRoleId && (
					<Check
						className="h-4 w-4 text-th-accent"
						strokeWidth={2.5}
						aria-hidden="true"
					/>
				)}
			</button>
		</div>
	);
}
