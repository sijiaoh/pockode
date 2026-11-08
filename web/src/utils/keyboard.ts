import type { KeyboardEvent } from "react";

/** Whether a key press is part of an IME composition rather than its own. */
export function composing(event: KeyboardEvent): boolean {
	// 229 is what macOS and iOS Safari send for the Enter that commits a
	// composition, which arrives after `compositionend`.
	return event.nativeEvent.isComposing || event.keyCode === 229;
}
