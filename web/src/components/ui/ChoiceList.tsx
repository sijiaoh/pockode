import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";

/**
 * The rows of a pick-one-of list, shared by every panel that offers one
 * (session engine, agent role engine). Presentation only: the selected dot
 * follows whatever the caller passes, never the click.
 */

// Decorative: the radio it belongs to already reports the selection.
function SelectionDot({ selected }: { selected: boolean }) {
	return (
		<div
			aria-hidden="true"
			className={`h-4 w-4 flex-shrink-0 rounded-full border-2 ${
				selected ? "border-th-accent bg-th-accent" : "border-th-text-muted"
			}`}
		>
			{selected && (
				// strokeWidth 3 in lucide's 24 viewBox, as the mode and agent lists
				// have always drawn it.
				<Check className="h-full w-full text-th-accent-text" strokeWidth={3} />
			)}
		</div>
	);
}

/**
 * One row of any section. A real radio rather than a button: each section is a
 * pick-one-of, and the browser's own radio gives that to a screen
 * reader and to arrow keys for free. It stays visually hidden — the dot is drawn
 * from `selected`, which follows the server's answer, not the click.
 */
export function ChoiceRow({
	group,
	value,
	label,
	description,
	selected,
	onSelect,
}: {
	group: string;
	value: string;
	label: ReactNode;
	description?: string;
	selected: boolean;
	onSelect: () => void;
}) {
	const descId = useId();

	return (
		// A row without a description no longer gets its height from two lines of
		// text, so the hit area has to be spelled out.
		<label
			className={`flex w-full cursor-pointer gap-3 px-3 py-3 text-left transition-colors has-[:disabled]:cursor-default pointer-coarse:py-3.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-th-accent has-[:focus-visible]:ring-inset ${
				description ? "items-start" : "items-center"
			} ${selected ? "bg-th-accent/15" : "hover:bg-th-bg-tertiary"}`}
		>
			<input
				type="radio"
				name={group}
				value={value}
				checked={selected}
				onChange={onSelect}
				aria-describedby={description ? descId : undefined}
				className="sr-only"
			/>
			<div className={description ? "mt-0.5" : undefined}>
				<SelectionDot selected={selected} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5 truncate text-sm font-medium text-th-text-primary">
					{label}
				</div>
				{description && (
					<div
						id={descId}
						className="mt-0.5 whitespace-pre text-xs text-th-text-muted"
					>
						{description}
					</div>
				)}
			</div>
		</label>
	);
}

export function Section({
	title,
	disabled,
	children,
}: {
	title: string;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		// min-w-0: a fieldset's UA `min-inline-size: min-content` is the one default
		// Tailwind's reset leaves behind, and it would let a long model id push past
		// the panel instead of being truncated by its row.
		<fieldset
			disabled={disabled}
			className={`min-w-0 ${disabled ? "opacity-50" : ""}`}
		>
			<legend className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-th-text-muted">
				{title}
			</legend>
			{children}
		</fieldset>
	);
}
