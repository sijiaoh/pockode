import type { ContentPart, Message } from "../types/message";

/**
 * What one content part contributes to a preview of its message. Empty for the
 * parts that carry no words of their own.
 */
function partPreview(part: ContentPart): string {
	switch (part.type) {
		case "text":
		case "command_output":
			return part.content;
		case "warning":
			return part.message;
		case "tool_call":
			return part.tool.name;
		case "task":
			return part.task.description;
		case "permission_request":
			return part.request.toolName;
		case "ask_user_question":
			return part.request.questions[0]?.header ?? "";
		// A `system` or `raw` part is the CLI's own bookkeeping rendered verbatim;
		// quoting it back would identify the message by its least legible half.
		default:
			return "";
	}
}

/**
 * A message reduced to the words that identify it, for quoting it somewhere it
 * cannot be rendered in full — the title of its menu, the anchor echoed back in
 * the fork sheet. Whitespace is collapsed so a multi-line message stays
 * quotable on one line; the caller decides how much of it to show.
 *
 * Empty when nothing in the message reads as words — the caller decides what to
 * put there, rather than this function inventing a description of the message.
 */
export function messagePreview(message: Message): string {
	const raw =
		message.role === "user"
			? message.content
			: message.parts.map(partPreview).filter(Boolean).join(" ");
	return raw.replace(/\s+/g, " ").trim();
}
