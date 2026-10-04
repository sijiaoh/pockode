import { Check, Copy, X } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

interface Props {
	/**
	 * What to copy. A function when producing it costs something — serializing
	 * an input nobody has opened — so it is paid for only on the press.
	 */
	text: string | (() => string);
	/** Placement and size; the hit area is the button's own. */
	className: string;
	/** The button's name until it has been pressed. */
	label?: string;
}

/**
 * Copies a block's text and says, on the button itself, how that went.
 *
 * Bare of any placement: inside a block's header (`BlockHeader`) or laid over a
 * code block's corner, the caller decides where it sits and how large.
 */
export function CopyButton({ text, className, label = "Copy" }: Props) {
	const { state, copy } = useCopyToClipboard({ resetAfterMs: 2000 });

	return (
		<button
			type="button"
			onClick={() => copy(typeof text === "function" ? text() : text)}
			// `touch-target` here rather than from each caller: every placement is
			// smaller than a finger, and the hit area is the button's own business.
			className={`touch-target ${className}`}
			// A failed copy needs nothing more: the text is on screen in full.
			aria-label={
				state === "copied"
					? "Copied"
					: state === "failed"
						? "Copy failed"
						: label
			}
		>
			{state === "copied" ? (
				<Check size={14} />
			) : state === "failed" ? (
				<X size={14} />
			) : (
				<Copy size={14} />
			)}
		</button>
	);
}
