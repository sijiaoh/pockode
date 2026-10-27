import { Check, Minus } from "lucide-react";
import type { CheckState } from "../../lib/gitChanges";
import { Spinner } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";

interface Props {
	state: CheckState;
	/** Names the property the box holds, `Stage <path>`; the state is spoken on its own. */
	label: string;
	/** A write for these files is queued or running. */
	busy: boolean;
	onToggle: () => void;
}

const ARIA_CHECKED = {
	checked: "true",
	unchecked: "false",
	mixed: "mixed",
} as const;

/**
 * Whether a file's — or a set of files' — current content will be committed.
 *
 * A button rather than an `<input>`, so that mixed is a real `aria-checked`
 * state and not a third icon. While busy it stays focusable and only ignores
 * presses: `disabled` would drop the focus of a keyboard user who just
 * pressed Space. The state is never flipped ahead of the status saying so.
 */
function StageCheckbox({ state, label, busy, onToggle }: Props) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: an input's mixed state is a DOM property with no attribute, and it would need `disabled` while busy
		<button
			type="button"
			role="checkbox"
			aria-checked={ARIA_CHECKED[state]}
			aria-label={label}
			aria-disabled={busy || undefined}
			aria-busy={busy || undefined}
			onClick={busy ? undefined : onToggle}
			className={iconButtonClass({ busy })}
		>
			<span
				className={`flex size-5 items-center justify-center rounded border ${
					state === "unchecked"
						? "border-th-border-focus"
						: "border-th-accent bg-th-accent text-th-accent-text"
				}`}
			>
				{busy ? (
					<Spinner variant="current" size="h-3 w-3" srText={null} />
				) : state === "checked" ? (
					<Check className="size-3.5" strokeWidth={3} aria-hidden="true" />
				) : state === "mixed" ? (
					<Minus className="size-3.5" strokeWidth={3} aria-hidden="true" />
				) : null}
			</span>
		</button>
	);
}

export default StageCheckbox;
