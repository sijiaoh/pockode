import { useLayoutEffect, useRef } from "react";
import {
	getSessionKindInfo,
	SESSION_KINDS,
	type SessionKind,
} from "../../lib/sessionKind";
import type { ValueState } from "../../lib/valueState";
import ToggleGroup from "../ui/ToggleGroup";
import type { SessionKindSwitch } from "./useSessionKindSwitch";

interface Props {
	/** The session's stored kind — never the one just pressed. */
	kind: SessionKind;
	valueState: ValueState;
	kindSwitch: SessionKindSwitch;
}

/**
 * The choice between a chat and a canvas session, drawn on the empty state of
 * a session that has not started (docs/new-session-ui.md §3). It sits in
 * whichever view the kind puts the session in, so a switch draws it again in
 * the other one; the segment pressed gets the focus back there.
 */
export default function SessionKindChooser({
	kind,
	valueState,
	kindSwitch,
}: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const { choosing } = kindSwitch;
	// On mount only: the instance drawn after a switch is a new one, and the
	// lit segment in it is the one that was pressed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a press in this instance already has the focus where it belongs
	useLayoutEffect(() => {
		if (!choosing) return;
		ref.current
			?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
			?.focus();
	}, []);

	return (
		<div ref={ref} className="w-full max-w-sm space-y-1.5">
			<ToggleGroup<SessionKind>
				label="Session"
				items={SESSION_KINDS}
				selected={kind}
				onSelect={kindSwitch.choose}
				getInfo={getSessionKindInfo}
				hint={getSessionKindInfo(kind).description}
				error={kindSwitch.error}
				valueState={valueState}
				disabled={kindSwitch.pending}
			/>
			<p className="text-xs text-th-text-muted">
				Can be changed until you send the first message.
			</p>
		</div>
	);
}
