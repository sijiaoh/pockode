import { Paperclip } from "lucide-react";

/**
 * Says what a file held over the chat would do, for as long as it is held.
 *
 * Drawn over the whole zone rather than docked like the Files tab's bar: there
 * is nothing in the chat to aim at, so covering it hides nothing the user needs.
 * Transparent to the pointer, or the drag would be over this and not the zone.
 */
function ChatDropOverlay({
	refusal,
}: {
	/** Why this drag will not be taken, when it will not be. */
	refusal: string | null;
}) {
	return (
		<div
			aria-hidden="true"
			data-testid="chat-drop-overlay"
			className={`pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-th-bg-primary/80 ${
				refusal ? "" : "ring-2 ring-th-accent ring-inset"
			}`}
		>
			<div
				className={`flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-xl border border-th-border px-4 py-3 text-sm ${
					refusal
						? "bg-th-bg-tertiary text-th-text-secondary"
						: "bg-th-bg-secondary text-th-text-primary shadow"
				}`}
			>
				{/* With the ring, the only thing telling accepting from refusing
				    apart other than by the words — as on the Files tab's bar. */}
				<Paperclip
					className={`size-4 shrink-0 ${refusal ? "" : "text-th-accent"}`}
				/>
				<span>{refusal ?? "Drop files to attach"}</span>
			</div>
		</div>
	);
}

export default ChatDropOverlay;
