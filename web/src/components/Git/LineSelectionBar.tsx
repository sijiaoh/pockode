import { Check, Loader2, Sparkles, X } from "lucide-react";
import { type Ref, useEffect } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { iconButtonClass } from "../ui/iconButtonClass";

interface Props {
	/** `Lines 41–42`, `Removed lines 41–43`, `Old line 41`. */
	label: string;
	/** Read on the press: the code is assembled only when it is asked for. */
	copyText: () => string;
	onAsk: () => void;
	/** A session is being created for the text. */
	asking: boolean;
	onClear: () => void;
	/** Focus goes here when the selection was made with a hunk's Select button. */
	copyRef?: Ref<HTMLButtonElement>;
	barRef?: Ref<HTMLDivElement>;
	/** Whether focus is in the bar, for the page to put it back when the bar goes. */
	onFocusChange?: (focused: boolean) => void;
}

/** Long enough to read `Copied`, short enough not to feel like a wait. */
const COPIED_MS = 1000;

// Each wide enough for its busy and done labels, so a press never moves the
// button beside it.
const buttonClass =
	"flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-th-bg-tertiary px-3 text-sm text-th-text-primary transition-opacity hover:opacity-90 pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";

/**
 * What can be done with the lines selected in the review: copy them, or hand
 * them to the agent (docs/git-changes-ui.md#the-selection-bar). Docked above
 * the review's bottom bar rather than beside the selection, and not portalled,
 * so it goes with the page.
 */
function LineSelectionBar({
	label,
	copyText,
	onAsk,
	asking,
	onClear,
	copyRef,
	barRef,
	onFocusChange,
}: Props) {
	const { state: copyState, copy, reset } = useCopyToClipboard();
	// Only success goes back by itself: a failure stays until the next press,
	// so it cannot flash past a reader who looked away.
	useEffect(() => {
		if (copyState !== "copied") return;
		const timer = setTimeout(reset, COPIED_MS);
		return () => clearTimeout(timer);
	}, [copyState, reset]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls, and these are actions
		<div
			ref={barRef}
			role="group"
			aria-label="Selected lines"
			onFocus={() => onFocusChange?.(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					onFocusChange?.(false);
				}
			}}
			className="flex shrink-0 items-center gap-2 border-t border-th-border bg-th-bg-secondary py-1.5 pr-1 pl-3 shadow-xl"
		>
			<span className="min-w-0 flex-1 truncate text-xs tabular-nums text-th-text-primary">
				{label}
			</span>
			<span className="sr-only" aria-live="polite">
				{copyState === "copied"
					? "Copied"
					: copyState === "failed"
						? "Copy failed"
						: ""}
			</span>
			<button
				ref={copyRef}
				type="button"
				onClick={() => copy(copyText())}
				className={`${buttonClass} min-w-24`}
			>
				{copyState === "copied" ? (
					<>
						<Check className="h-4 w-4" aria-hidden="true" />
						Copied
					</>
				) : copyState === "failed" ? (
					"Copy failed"
				) : (
					"Copy"
				)}
			</button>
			<button
				type="button"
				onClick={asking ? undefined : onAsk}
				aria-busy={asking || undefined}
				className={`${buttonClass} min-w-34`}
			>
				{asking ? (
					<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
				) : (
					<Sparkles className="h-4 w-4" aria-hidden="true" />
				)}
				{asking ? "Opening chat…" : "Ask AI to edit…"}
			</button>
			<button
				type="button"
				onClick={onClear}
				aria-label="Clear selection"
				className={iconButtonClass()}
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</div>
	);
}

export default LineSelectionBar;
