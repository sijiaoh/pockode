import { Check } from "lucide-react";
import type { InputHTMLAttributes } from "react";

/**
 * What a pick means: one the user can still change, one that went out, or one
 * on screen that is not going out (a declined block).
 */
export type ChoiceTone = "actionable" | "settled" | "withheld";

const TONE: Record<ChoiceTone, { radio: string; checkbox: string }> = {
	actionable: {
		radio: "checked:border-th-accent",
		checkbox: "checked:border-th-accent checked:bg-th-accent",
	},
	settled: {
		radio: "checked:border-th-success",
		checkbox: "checked:border-th-success checked:bg-th-success",
	},
	withheld: {
		radio: "checked:border-th-text-muted",
		checkbox: "checked:border-th-text-muted checked:bg-th-text-muted",
	},
};

const BASE =
	"peer col-start-1 row-start-1 size-4 appearance-none border-2 border-th-text-muted bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-th-accent";

interface Props
	extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> {
	type: "radio" | "checkbox";
	tone: ChoiceTone;
	/** Placement of the control beside its label, e.g. a top offset. */
	className?: string;
}

/**
 * A radio or checkbox drawn rather than left to the browser: under a dark
 * `color-scheme` Chromium fills an unpicked one grey, which reads as disabled.
 * Unpicked is a ring or a box on a clear ground in either theme; picking
 * thickens the ring into a dot, or fills the box under a tick.
 */
function ChoiceInput({ type, tone, className = "", ...rest }: Props) {
	return (
		<span className={`grid size-4 shrink-0 ${className}`}>
			<input
				type={type}
				className={`${BASE} ${
					type === "radio" ? "rounded-full checked:border-[5px]" : "rounded-sm"
				} ${TONE[tone][type]}`}
				{...rest}
			/>
			{type === "checkbox" && (
				<Check
					aria-hidden
					strokeWidth={3}
					className="pointer-events-none col-start-1 row-start-1 hidden size-3 place-self-center text-th-text-inverse peer-checked:block"
				/>
			)}
		</span>
	);
}

export default ChoiceInput;
