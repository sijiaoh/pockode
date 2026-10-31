import { Lock, X } from "lucide-react";
import { type Ref, useState } from "react";
import { toolSummary, toolSummaryLine } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type { PermissionRequest } from "../../types/message";

/** What a refused send from the page says, in the banner or the panel (§10.3). */
export const PERMISSION_SEND_REFUSED = "Answer the permission request first.";

// The attention strip's permission line: 44px with its `h-7` pill.
const BANNER_LINE =
	"mx-auto flex max-w-3xl items-center gap-2 px-3 py-2 text-xs";

/**
 * Over the banner or the panel's header for each refused send, restarted by
 * remounting it under the attempt's key. A layer rather than re-keying what it
 * flashes, which would drop focus from it; transparent at rest, so with
 * reduced motion — no animation — there is no flash at all.
 */
export function RefusalFlash({ attempt }: { attempt: number }) {
	// Only for attempts made while this is on the screen: a banner or panel
	// mounting after an earlier refusal has nothing new to flash for.
	const [shownFrom] = useState(attempt);
	if (attempt === shownFrom) return null;
	return (
		<span
			key={attempt}
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 animate-permission-flash bg-th-warning/30 opacity-0"
		/>
	);
}

/**
 * The collapsed permission panel (docs/canvas-ui.md §10.2): one line at the top
 * of the canvas's column saying requests are waiting, and the way back to them.
 * One button — no Allow or Deny here: answering from a cut line would be
 * granting something unread.
 */
export function PermissionBanner({
	count,
	oldest,
	refused,
	attempt,
	onShow,
	buttonRef,
}: {
	/** The requests waiting, unanswered. */
	count: number;
	/** The oldest pending request that has a record, for its summary. */
	oldest: PermissionRequest | null;
	/** A send was refused a moment ago: the sentence takes the text's place. */
	refused: boolean;
	/** Refused sends so far; each one flashes. */
	attempt: number;
	onShow: () => void;
	buttonRef?: Ref<HTMLButtonElement>;
}) {
	const workDir = useWSStore((state) => state.workDir);
	const summary =
		oldest &&
		toolSummaryLine(toolSummary(oldest.toolName, oldest.toolInput, workDir));
	return (
		<div className="relative shrink-0 border-b border-th-warning bg-th-warning/10">
			{/* No `aria-label`: its name is its visible text, summary included. */}
			<button
				ref={buttonRef}
				type="button"
				onClick={onShow}
				className="block min-h-11 w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
			>
				<span className={BANNER_LINE}>
					<Lock
						className="size-3 shrink-0 text-th-warning"
						aria-hidden="true"
					/>
					{/* In place, not on a line of its own: a line appearing would push
					    the page down under the finger that just pressed in it. */}
					{refused ? (
						<span className="min-w-0 flex-1 truncate font-medium text-th-text-primary">
							{PERMISSION_SEND_REFUSED}
						</span>
					) : (
						<span className="flex min-w-0 flex-1 items-center gap-1">
							<span className="shrink-0 font-medium text-th-text-primary">
								{count === 1
									? "1 permission request waiting"
									: `${count} permission requests waiting`}
							</span>
							{summary && (
								<>
									<span aria-hidden="true" className="text-th-text-muted">
										·
									</span>
									<span className="min-w-0 truncate text-th-text-muted">
										{summary}
									</span>
								</>
							)}
						</span>
					)}
					<span className="flex h-7 shrink-0 items-center rounded-md bg-th-accent px-3 font-medium text-th-accent-text">
						Show
					</span>
				</span>
			</button>
			<RefusalFlash attempt={attempt} />
			{/* Beside the button, never inside it, where its name would override
			    it. Unchanged while attempts keep restarting the sentence, so a
			    page sending in a loop is announced once. */}
			<output className="sr-only">
				{refused ? PERMISSION_SEND_REFUSED : ""}
			</output>
		</div>
	);
}

/**
 * What became of a batch's requests that expired without the user causing it,
 * once the batch is over (docs/canvas-ui.md §10.1): so the banner going is
 * never the only trace. The canvas view's UI state, dismissed by its ✕.
 */
export function PermissionExpiryLine({
	text,
	onDismiss,
}: {
	text: string;
	onDismiss: () => void;
}) {
	return (
		<div className="shrink-0 border-b border-th-border bg-th-bg-secondary">
			<div className={`${BANNER_LINE} text-th-text-secondary`}>
				<span className="min-w-0 flex-1">{text}</span>
				<button
					type="button"
					onClick={onDismiss}
					aria-label="Dismiss"
					className="touch-target flex size-5 shrink-0 items-center justify-center rounded text-th-text-muted transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				>
					<X className="size-3.5" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}
