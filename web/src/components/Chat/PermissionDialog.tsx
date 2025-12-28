import type {
	PermissionRequest,
	PermissionRuleValue,
	PermissionUpdate,
	PermissionUpdateDestination,
} from "../../types/message";
import DialogShell from "./DialogShell";

interface Props {
	request: PermissionRequest;
	onAllow: () => void;
	onAlwaysAllow: () => void;
	onDeny: () => void;
}

function formatPermissionRule(rule: PermissionRuleValue): string {
	if (rule.ruleContent) {
		return `${rule.toolName}(${rule.ruleContent})`;
	}
	return rule.toolName;
}

function getDestinationLabel(destination: PermissionUpdateDestination): string {
	switch (destination) {
		case "session":
			return "this session";
		case "projectSettings":
			return "this project";
		case "localSettings":
			return "local settings";
		case "userSettings":
			return "all projects";
	}
}

function hasRules(
	update: PermissionUpdate,
): update is PermissionUpdate & { rules: PermissionRuleValue[] } {
	return "rules" in update;
}

function formatInput(input: unknown): string {
	if (typeof input === "string") return input;
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return String(input);
	}
}

function PermissionDialog({ request, onAllow, onAlwaysAllow, onDeny }: Props) {
	const suggestion: PermissionUpdate | undefined =
		request.permissionSuggestions?.[0];

	const actions = [
		{ label: "Deny", onClick: onDeny, variant: "secondary" as const },
		...(suggestion
			? [
					{
						label: "Always Allow",
						onClick: onAlwaysAllow,
						variant: "success" as const,
					},
				]
			: []),
		{ label: "Allow", onClick: onAllow, variant: "primary" as const },
	];

	return (
		<DialogShell
			title="Tool Permission Request"
			description="The AI wants to use a tool. Do you allow it?"
			actions={actions}
			onClose={onDeny}
		>
			<div className="mb-3">
				<span className="text-sm text-th-text-muted">Tool:</span>
				<span className="ml-2 font-mono text-th-accent">
					{request.toolName}
				</span>
			</div>

			<div>
				<span className="text-sm text-th-text-muted">Input:</span>
				<pre className="mt-2 overflow-x-auto rounded bg-th-code-bg p-3 text-sm text-th-code-text">
					{formatInput(request.toolInput)}
				</pre>
			</div>

			{suggestion && hasRules(suggestion) && (
				<div className="mt-4 rounded bg-th-bg-primary/50 p-3">
					<p className="mb-1 text-xs text-th-text-muted">
						"Always Allow" will add to{" "}
						{getDestinationLabel(suggestion.destination)}:
					</p>
					<div className="flex flex-wrap gap-1.5">
						{suggestion.rules.map((rule, idx) => (
							<code
								key={`${rule.toolName}-${idx}`}
								className="rounded bg-th-success/20 px-1.5 py-0.5 text-xs text-th-success"
							>
								{formatPermissionRule(rule)}
							</code>
						))}
					</div>
				</div>
			)}
		</DialogShell>
	);
}

export default PermissionDialog;
