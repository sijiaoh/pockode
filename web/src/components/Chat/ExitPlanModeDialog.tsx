import type { PermissionRequest } from "../../types/message";
import DialogShell from "./DialogShell";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
	request: PermissionRequest;
	onApprove: () => void;
	onReject: () => void;
}

function extractPlanContent(toolInput: unknown): string | null {
	if (!toolInput || typeof toolInput !== "object") {
		return null;
	}
	const input = toolInput as { plan?: unknown };
	if (typeof input.plan === "string") {
		return input.plan;
	}
	return null;
}

function ExitPlanModeDialog({ request, onApprove, onReject }: Props) {
	const planContent = extractPlanContent(request.toolInput);

	const actions = [
		{ label: "Reject", onClick: onReject, variant: "secondary" as const },
		{ label: "Approve Plan", onClick: onApprove, variant: "primary" as const },
	];

	return (
		<DialogShell
			title="Implementation Plan"
			description="Review the plan and approve to proceed with implementation."
			actions={actions}
			onClose={onReject}
		>
			{planContent ? (
				<MarkdownContent content={planContent} />
			) : (
				<pre className="overflow-x-auto rounded bg-th-code-bg p-3 text-sm text-th-code-text">
					{request.toolInput
						? JSON.stringify(request.toolInput, null, 2)
						: "No plan content available."}
				</pre>
			)}
		</DialogShell>
	);
}

export default ExitPlanModeDialog;
