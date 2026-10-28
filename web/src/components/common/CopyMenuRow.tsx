import { Check, Copy } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import MenuRow from "./MenuRow";

/** Long enough to read `Copied`, short enough not to feel like a wait. */
const COPIED_CLOSE_MS = 1000;

interface Props {
	text: string;
	/** `Copy path`, `Copy hash`. */
	label: string;
	/** Closes the menu once the row has said `Copied`. */
	onCopied: () => void;
}

/**
 * A menu sheet's copy row. It says `Copied` before the sheet goes, so the
 * press is seen to work; a failure keeps the sheet, whose title holds the
 * text to copy by hand.
 */
function CopyMenuRow({ text, label, onCopied }: Props) {
	const { state, copy } = useCopyToClipboard();

	// Read when the timer fires: a caller's fresh callback on each render must
	// not restart the second.
	const onCopiedRef = useRef(onCopied);
	onCopiedRef.current = onCopied;
	useEffect(() => {
		if (state !== "copied") return;
		const timer = window.setTimeout(
			() => onCopiedRef.current(),
			COPIED_CLOSE_MS,
		);
		return () => clearTimeout(timer);
	}, [state]);

	return (
		<MenuRow
			icon={state === "copied" ? Check : Copy}
			label={
				state === "copied"
					? "Copied"
					: state === "failed"
						? "Copy failed"
						: label
			}
			onClick={() => {
				copy(text);
			}}
		/>
	);
}

export default CopyMenuRow;
