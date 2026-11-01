import { MessageSquare } from "lucide-react";
import { headerIconButtonClass } from "../ui";

export type CanvasSessionView = "canvas" | "chat";

/**
 * The session header's **Chat view** toggle (docs/canvas-ui.md §2.1). It
 * holds no state: which view is up is the session screen's, so it is pressed
 * by the view, whoever switched it.
 *
 * Named for chat because canvas is the session's home view and the transcript
 * the detour. The name stays fixed and `aria-pressed` carries the state: a
 * name that swung with the view would contradict the pressed state.
 */
export function CanvasViewSwitch({
	view,
	onSelect,
}: {
	view: CanvasSessionView;
	onSelect: (view: CanvasSessionView) => void;
}) {
	const isChat = view === "chat";
	return (
		<button
			type="button"
			aria-label="Chat view"
			aria-pressed={isChat}
			title="Chat view"
			onClick={() => onSelect(isChat ? "canvas" : "chat")}
			// The fill alone is every header button's hover; the accent glyph is
			// what tells "on" from "pointed at". Tailwind emits `aria-*` variants
			// after `hover:`, so the accent outlasts the class's own hover colour.
			className={`${headerIconButtonClass} aria-pressed:bg-th-bg-tertiary aria-pressed:text-th-accent`}
		>
			<MessageSquare className="size-5" aria-hidden="true" />
		</button>
	);
}
