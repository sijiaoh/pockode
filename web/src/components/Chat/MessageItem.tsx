import { useState } from "react";
import type { ContentPart, Message, ToolCall } from "../../types/message";
import { Spinner } from "../ui";

interface ToolCallItemProps {
	tool: ToolCall;
}

/** Extract a short summary from tool input for display */
function getToolSummary(tool: ToolCall): string {
	const input = tool.input;
	if (!input || typeof input !== "object") return "";

	const obj = input as Record<string, unknown>;

	// Bash: show description or truncated command
	if (tool.name === "Bash") {
		if (typeof obj.description === "string") return obj.description;
		if (typeof obj.command === "string") {
			const cmd = obj.command;
			return cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd;
		}
	}

	// Read/Edit/Write: show file path
	if (typeof obj.file_path === "string") {
		const path = obj.file_path;
		// Show just the filename or last part of path
		const pathParts = path.split("/");
		return pathParts.length > 2 ? `.../${pathParts.slice(-2).join("/")}` : path;
	}

	// Grep: show pattern
	if (tool.name === "Grep" && typeof obj.pattern === "string") {
		return `"${obj.pattern}"`;
	}

	// Glob: show pattern
	if (tool.name === "Glob" && typeof obj.pattern === "string") {
		return obj.pattern;
	}

	return "";
}

function ToolCallItem({ tool }: ToolCallItemProps) {
	const [expanded, setExpanded] = useState(false);
	const hasResult = Boolean(tool.result);
	const summary = getToolSummary(tool);

	return (
		<div className="rounded bg-gray-800 text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-2 p-2 text-left hover:bg-gray-750"
			>
				<span
					className={`text-gray-500 transition-transform ${expanded ? "rotate-90" : ""}`}
				>
					▶
				</span>
				<span className="shrink-0 text-blue-400">{tool.name}</span>
				{summary && <span className="truncate text-gray-400">{summary}</span>}
				{hasResult && !expanded && (
					<span className="ml-auto shrink-0 text-gray-500">...</span>
				)}
			</button>
			{expanded && tool.result && (
				<pre className="max-h-48 overflow-auto border-t border-gray-700 p-2 text-gray-400">
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
		<div className="rounded bg-gray-800 text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-2 p-2 text-left hover:bg-gray-750"
			>
				<span
					className={`text-gray-500 transition-transform ${expanded ? "rotate-90" : ""}`}
				>
					▶
				</span>
				<span className="italic text-gray-500">system</span>
			</button>
			{expanded && (
				<pre className="max-h-48 overflow-auto border-t border-gray-700 p-2 text-gray-400">
					{content}
				</pre>
			)}
		</div>
	);
}

interface ContentPartItemProps {
	part: ContentPart;
}

function ContentPartItem({ part }: ContentPartItemProps) {
	if (part.type === "text") {
		return (
			<p className="whitespace-pre-wrap break-words text-gray-100">
				{part.content}
			</p>
		);
	}
	if (part.type === "system") {
		return <SystemItem content={part.content} />;
	}
	return <ToolCallItem tool={part.tool} />;
}

interface Props {
	message: Message;
}

function MessageItem({ message }: Props) {
	const isUser = message.role === "user";

	// User messages use content; assistant messages use parts
	const renderContent = () => {
		if (isUser) {
			return (
				<p className="whitespace-pre-wrap break-words">{message.content}</p>
			);
		}

		// Assistant message with parts (timeline order)
		// Parts are append-only during streaming, so index is stable
		if (message.parts && message.parts.length > 0) {
			return (
				<div className="space-y-2">
					{message.parts.map((part, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only
						<ContentPartItem key={index} part={part} />
					))}
				</div>
			);
		}

		// Fallback for empty assistant message
		return null;
	};

	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[80%] rounded-lg p-3 ${
					isUser ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-100"
				}`}
			>
				{renderContent()}

				{/* Status indicator */}
				{(message.status === "sending" || message.status === "streaming") && (
					<Spinner className="mt-2" />
				)}
				{message.status === "error" && (
					<p className="mt-2 text-sm text-red-400">{message.error}</p>
				)}
				{message.status === "interrupted" && (
					<p className="mt-2 text-sm text-gray-400">Interrupted</p>
				)}
			</div>
		</div>
	);
}

export default MessageItem;
