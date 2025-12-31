import { useState } from "react";
import type {
	AskUserQuestionRequest,
	ContentPart,
	Message,
	PermissionRequest,
	PermissionRuleValue,
	PermissionStatus,
	PermissionUpdate,
	PermissionUpdateDestination,
	ToolCall,
} from "../../types/message";
import { ScrollableContent, Spinner } from "../ui";
import AskUserQuestionItem from "./AskUserQuestionItem";
import { MarkdownContent } from "./MarkdownContent";

interface ToolCallItemProps {
	tool: ToolCall;
}

/** Extract a short summary from tool input for display */
function getInputSummary(toolName: string, input: unknown): string {
	if (!input || typeof input !== "object") return "";

	const obj = input as Record<string, unknown>;

	// Bash: show description or truncated command
	if (toolName === "Bash") {
		if (typeof obj.description === "string") return obj.description;
		if (typeof obj.command === "string") {
			const cmd = obj.command;
			return cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd;
		}
	}

	// Read/Edit/Write: show file path
	if (typeof obj.file_path === "string") {
		const path = obj.file_path;
		const parts = path.split("/");
		return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
	}

	// Grep/Glob: show pattern
	if (typeof obj.pattern === "string") {
		return toolName === "Grep" ? `"${obj.pattern}"` : obj.pattern;
	}

	// Fallback: first string value
	for (const value of Object.values(obj)) {
		if (typeof value === "string" && value.length > 0) {
			return value.length > 50 ? `${value.slice(0, 50)}...` : value;
		}
	}

	return "";
}

function ToolCallItem({ tool }: ToolCallItemProps) {
	const [expanded, setExpanded] = useState(false);
	const hasResult = Boolean(tool.result);
	const summary = getInputSummary(tool.name, tool.input);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => hasResult && setExpanded(!expanded)}
				className={`flex w-full items-center gap-1.5 rounded p-2 text-left ${hasResult ? "hover:bg-th-overlay-hover" : ""}`}
			>
				<span
					className={`w-2.5 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				>
					{hasResult && "▶"}
				</span>
				<span className="shrink-0 text-th-accent">{tool.name}</span>
				{summary && (
					<span className="truncate text-th-text-muted">{summary}</span>
				)}
			</button>
			{expanded && tool.result && (
				<pre className="max-h-48 overflow-auto border-t border-th-border p-2 text-th-text-muted">
					{tool.result}
				</pre>
			)}
		</div>
	);
}

interface SystemItemProps {
	content: string;
}

function SystemItem({ content }: SystemItemProps) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<span
					className={`w-2.5 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				>
					▶
				</span>
				<span className="italic text-th-text-muted">system</span>
			</button>
			{expanded && (
				<pre className="max-h-48 overflow-auto border-t border-th-border p-2 text-th-text-muted">
					{content}
				</pre>
			)}
		</div>
	);
}

type PermissionChoice = "deny" | "allow" | "always_allow";

interface PermissionRequestItemProps {
	request: PermissionRequest;
	status: PermissionStatus;
	onRespond?: (request: PermissionRequest, choice: PermissionChoice) => void;
}

/** Extract plan content from ExitPlanMode input */
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

/** Format tool input for display */
function formatInput(input: unknown): string {
	if (typeof input === "string") return input;
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return String(input);
	}
}

/** Format permission rule for display */
function formatPermissionRule(rule: PermissionRuleValue): string {
	if (rule.ruleContent) {
		return `${rule.toolName}(${rule.ruleContent})`;
	}
	return rule.toolName;
}

/** Get human-readable destination label */
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

/** Type guard for PermissionUpdate with rules */
function hasRules(
	update: PermissionUpdate,
): update is PermissionUpdate & { rules: PermissionRuleValue[] } {
	return "rules" in update;
}

function PermissionRequestItem({
	request,
	status,
	onRespond,
}: PermissionRequestItemProps) {
	const isPending = status === "pending";
	const [expanded, setExpanded] = useState(isPending);
	const summary = getInputSummary(request.toolName, request.toolInput);
	const isExitPlanMode = request.toolName === "ExitPlanMode";
	const planContent = isExitPlanMode
		? extractPlanContent(request.toolInput)
		: null;

	const statusConfig = {
		pending: { icon: "?", color: "text-th-warning" },
		allowed: { icon: "✓", color: "text-th-success" },
		denied: { icon: "✗", color: "text-th-error" },
	};

	const { icon, color } = statusConfig[status];

	return (
		<div
			className={`rounded text-xs ${isPending ? "border border-th-warning bg-th-warning/10" : "bg-th-bg-secondary"}`}
		>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<span className={`w-4 shrink-0 text-center ${color}`}>{icon}</span>
				<span className="shrink-0 text-th-accent">{request.toolName}</span>
				{summary && (
					<span className="truncate text-th-text-muted">{summary}</span>
				)}
				<span
					className={`ml-auto w-2.5 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				>
					▶
				</span>
			</button>

			{expanded && (
				<ScrollableContent className="max-h-64 overflow-auto border-t border-th-border p-2">
					{planContent ? (
						<MarkdownContent content={planContent} />
					) : (
						<pre className="overflow-x-auto rounded bg-th-code-bg p-2 text-th-code-text">
							{formatInput(request.toolInput)}
						</pre>
					)}
					{isPending &&
						request.permissionSuggestions &&
						request.permissionSuggestions.length > 0 &&
						hasRules(request.permissionSuggestions[0]) && (
							<div className="mt-2 rounded bg-th-bg-primary/50 p-2">
								<p className="mb-1 text-th-text-muted">
									"Always Allow" will add to{" "}
									{getDestinationLabel(
										request.permissionSuggestions[0].destination,
									)}
									:
								</p>
								<div className="flex flex-wrap gap-1">
									{request.permissionSuggestions[0].rules.map((rule, idx) => (
										<code
											key={`${rule.toolName}-${idx}`}
											className="rounded bg-th-success/20 px-1 py-0.5 text-th-success"
										>
											{formatPermissionRule(rule)}
										</code>
									))}
								</div>
							</div>
						)}
				</ScrollableContent>
			)}

			{isPending && onRespond && (
				<div className="flex justify-end gap-2 border-t border-th-border p-2">
					<button
						type="button"
						onClick={() => onRespond(request, "deny")}
						className="rounded bg-th-bg-secondary px-2 py-1 text-th-text-muted hover:bg-th-overlay-hover"
					>
						Deny
					</button>
					{request.permissionSuggestions &&
						request.permissionSuggestions.length > 0 && (
							<button
								type="button"
								onClick={() => onRespond(request, "always_allow")}
								className="rounded bg-th-success/20 px-2 py-1 text-th-success hover:bg-th-success/30"
							>
								Always Allow
							</button>
						)}
					<button
						type="button"
						onClick={() => onRespond(request, "allow")}
						className="rounded bg-th-accent px-2 py-1 text-th-bg hover:opacity-90"
					>
						Allow
					</button>
				</div>
			)}
		</div>
	);
}

interface ContentPartItemProps {
	part: ContentPart;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	onQuestionRespond?: (
		request: AskUserQuestionRequest,
		answers: Record<string, string> | null,
	) => void;
}

function ContentPartItem({
	part,
	onPermissionRespond,
	onQuestionRespond,
}: ContentPartItemProps) {
	if (part.type === "text") {
		return <MarkdownContent content={part.content} />;
	}
	if (part.type === "system") {
		return <SystemItem content={part.content} />;
	}
	if (part.type === "permission_request") {
		return (
			<PermissionRequestItem
				request={part.request}
				status={part.status}
				onRespond={onPermissionRespond}
			/>
		);
	}
	if (part.type === "ask_user_question") {
		return (
			<AskUserQuestionItem
				request={part.request}
				status={part.status}
				savedAnswers={part.answers}
				onRespond={onQuestionRespond}
			/>
		);
	}
	return <ToolCallItem tool={part.tool} />;
}

interface Props {
	message: Message;
	isLast?: boolean;
	isProcessRunning?: boolean;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	onQuestionRespond?: (
		request: AskUserQuestionRequest,
		answers: Record<string, string> | null,
	) => void;
}

function MessageItem({
	message,
	isLast,
	isProcessRunning,
	onPermissionRespond,
	onQuestionRespond,
}: Props) {
	if (message.role === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[80%] min-w-0 overflow-hidden rounded-lg bg-th-user-bubble p-2.5 text-th-user-bubble-text sm:p-3">
					<p className="whitespace-pre-wrap break-words">{message.content}</p>
				</div>
			</div>
		);
	}

	// Assistant message
	return (
		<div className="flex justify-start">
			<div className="max-w-[80%] min-w-0 overflow-hidden rounded-lg bg-th-ai-bubble p-2.5 text-th-ai-bubble-text sm:p-3">
				{message.parts.length > 0 && (
					<div className="space-y-2">
						{message.parts.map((part, index) => {
							const key =
								part.type === "permission_request"
									? part.request.requestId
									: part.type === "ask_user_question"
										? part.request.requestId
										: part.type === "tool_call"
											? part.tool.id
											: `${part.type}-${index}`;
							return (
								<ContentPartItem
									key={key}
									part={part}
									onPermissionRespond={onPermissionRespond}
									onQuestionRespond={onQuestionRespond}
								/>
							);
						})}
					</div>
				)}

				{/* Status indicator */}
				{message.status === "sending" && <Spinner className="mt-2" />}
				{message.status === "streaming" &&
					(isLast && isProcessRunning ? (
						<Spinner className="mt-2" />
					) : (
						<p className="mt-2 text-sm text-th-warning">Process ended</p>
					))}
				{message.status === "error" && (
					<p className="mt-2 text-sm text-th-error">{message.error}</p>
				)}
				{message.status === "interrupted" && (
					<p className="mt-2 text-sm text-th-text-muted">Interrupted</p>
				)}
				{message.status === "process_ended" && (
					<p className="mt-2 text-sm text-th-warning">Process ended</p>
				)}
			</div>
		</div>
	);
}

export type { PermissionChoice };
export default MessageItem;
