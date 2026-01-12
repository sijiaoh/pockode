import {
	AlertTriangle,
	Check,
	ChevronRight,
	CircleHelp,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useWSStore } from "../../lib/wsStore";
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
import ToolResultDisplay from "./ToolResultDisplay";

interface ToolCallItemProps {
	tool: ToolCall;
}

/** Format file path as "filename (relative/dir)" for display */
function formatFilePath(filePath: string, workDir: string): string {
	const parts = filePath.split("/").filter(Boolean);
	if (parts.length === 0) return filePath;

	const fileName = parts[parts.length - 1];
	if (parts.length === 1) return fileName;

	// If path is within workDir, show relative path
	if (workDir && filePath.startsWith(workDir)) {
		const relativePath = filePath.slice(workDir.length).replace(/^\//, "");
		const relativeParts = relativePath.split("/").filter(Boolean);
		relativeParts.pop();
		if (relativeParts.length === 0) return fileName;
		return `${fileName} (${relativeParts.join("/")})`;
	}

	// For paths outside workDir, show only parent directory
	const parentDir = parts[parts.length - 2];
	return `${fileName} (${parentDir})`;
}

/** Extract a short summary from tool input for display */
function getInputSummary(
	toolName: string,
	input: unknown,
	workDir: string,
): string {
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

	// Read/Edit/Write: show file name with relative directory path
	if (typeof obj.file_path === "string") {
		return formatFilePath(obj.file_path, workDir);
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
	const workDir = useWSStore((state) => state.workDir);
	const summary = getInputSummary(tool.name, tool.input, workDir);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => hasResult && setExpanded(!expanded)}
				className={`flex w-full items-center gap-1.5 rounded p-2 text-left ${hasResult ? "hover:bg-th-overlay-hover" : ""}`}
			>
				{hasResult ? (
					<ChevronRight
						className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
					/>
				) : (
					<span className="size-3 shrink-0" />
				)}
				<span className="shrink-0 text-th-accent">{tool.name}</span>
				{summary && (
					<span className="truncate text-th-text-muted">{summary}</span>
				)}
			</button>
			{expanded && tool.result && (
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					<ToolResultDisplay
						toolName={tool.name}
						toolInput={tool.input}
						result={tool.result}
					/>
				</ScrollableContent>
			)}
		</div>
	);
}

interface SystemItemProps {
	content: string;
}

interface SystemContent {
	subtype: string;
	status?: string;
}

function SystemItem({ content }: SystemItemProps) {
	const [expanded, setExpanded] = useState(false);
	const label = useMemo(() => {
		const parsed: SystemContent = JSON.parse(content);
		return parsed.status
			? `${parsed.subtype}: ${parsed.status}`
			: parsed.subtype;
	}, [content]);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<span className="italic text-th-text-muted">{label}</span>
			</button>
			{expanded && (
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					<pre className="text-th-text-muted">{content}</pre>
				</ScrollableContent>
			)}
		</div>
	);
}

interface WarningItemProps {
	message: string;
	code: string;
}

function WarningItem({ message, code }: WarningItemProps) {
	return (
		<div className="flex items-start gap-2 rounded bg-th-warning/10 p-2 text-sm text-th-warning">
			<AlertTriangle className="size-4 shrink-0" />
			<div>
				<span>{message}</span>
				<span className="ml-2 text-xs opacity-70">({code})</span>
			</div>
		</div>
	);
}

interface RawItemProps {
	content: string;
}

function RawItem({ content }: RawItemProps) {
	const [expanded, setExpanded] = useState(false);
	const { label, formatted } = useMemo(() => {
		try {
			const parsed = JSON.parse(content);
			return {
				label: typeof parsed.type === "string" ? parsed.type : "raw",
				formatted: JSON.stringify(parsed, null, 2),
			};
		} catch {
			return { label: "raw", formatted: content };
		}
	}, [content]);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<span className="italic text-th-text-muted">{label}</span>
			</button>
			{expanded && (
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					<pre className="text-th-text-muted">{formatted}</pre>
				</ScrollableContent>
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

/** Check if input is empty (null, undefined, or empty object) */
function isEmptyInput(input: unknown): boolean {
	if (input == null) return true;
	if (typeof input === "object" && Object.keys(input as object).length === 0)
		return true;
	return false;
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
	const workDir = useWSStore((state) => state.workDir);
	const summary = getInputSummary(request.toolName, request.toolInput, workDir);
	const isExitPlanMode = request.toolName === "ExitPlanMode";
	const planContent = isExitPlanMode
		? extractPlanContent(request.toolInput)
		: null;
	const toolInputContent =
		!planContent && !isEmptyInput(request.toolInput)
			? formatInput(request.toolInput)
			: null;
	const permissionSuggestion =
		isPending &&
		request.permissionSuggestions &&
		request.permissionSuggestions.length > 0 &&
		hasRules(request.permissionSuggestions[0])
			? request.permissionSuggestions[0]
			: null;
	const hasExpandableContent = Boolean(
		planContent || toolInputContent || permissionSuggestion,
	);
	const [expanded, setExpanded] = useState(isPending && hasExpandableContent);

	const statusConfig = {
		pending: { Icon: CircleHelp, color: "text-th-warning" },
		allowed: { Icon: Check, color: "text-th-success" },
		denied: { Icon: X, color: "text-th-error" },
	};

	const { Icon, color } = statusConfig[status];

	return (
		<div
			className={`rounded text-xs ${isPending ? "border border-th-warning bg-th-warning/10" : "bg-th-bg-secondary"}`}
		>
			<button
				type="button"
				onClick={() => hasExpandableContent && setExpanded(!expanded)}
				className={`flex w-full items-center gap-1.5 rounded p-2 text-left ${hasExpandableContent ? "hover:bg-th-overlay-hover" : ""}`}
			>
				{hasExpandableContent ? (
					<ChevronRight
						className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
					/>
				) : (
					<span className="size-3 shrink-0" />
				)}
				<Icon className={`size-3 shrink-0 ${color}`} />
				<span className="shrink-0 text-th-accent">{request.toolName}</span>
				{summary && (
					<span className="truncate text-th-text-muted">{summary}</span>
				)}
			</button>

			{expanded && (
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					{planContent && <MarkdownContent content={planContent} />}
					{toolInputContent && (
						<pre className="overflow-x-auto rounded bg-th-code-bg p-2 text-th-code-text">
							{toolInputContent}
						</pre>
					)}
					{permissionSuggestion && (
						<div className="mt-2 rounded bg-th-bg-primary/50 p-2">
							<p className="mb-1 text-th-text-muted">
								"Always Allow" will add to{" "}
								{getDestinationLabel(permissionSuggestion.destination)}:
							</p>
							<div className="flex flex-wrap gap-1">
								{permissionSuggestion.rules.map((rule, idx) => (
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
	if (part.type === "warning") {
		return <WarningItem message={part.message} code={part.code} />;
	}
	if (part.type === "raw") {
		return <RawItem content={part.content} />;
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
				<div className="max-w-full min-w-0 overflow-hidden rounded-lg bg-th-user-bubble p-2.5 text-th-user-bubble-text sm:max-w-[80%] sm:p-3">
					<p className="whitespace-pre-wrap">{message.content}</p>
				</div>
			</div>
		);
	}

	// Assistant message
	return (
		<div className="flex justify-start">
			<div className="max-w-full min-w-0 overflow-hidden rounded-lg bg-th-ai-bubble p-2.5 text-th-ai-bubble-text sm:max-w-[80%] sm:p-3">
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
