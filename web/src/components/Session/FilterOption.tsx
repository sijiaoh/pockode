import { Check } from "lucide-react";
import { type ReactNode, useId } from "react";

interface Props {
	label: ReactNode;
	/** The second line under the label; rows in a group do without one. */
	description?: string;
	checked: boolean;
	onChange: () => void;
	/**
	 * Radio rows are one choice among several and share a `name`, which is what
	 * gives the group arrow-key navigation without any of it being written here.
	 */
	type?: "checkbox" | "radio";
	name?: string;
	/** Drawn before the label, inside the part that truncates. */
	icon?: ReactNode;
	/** Drawn at the end of the row, and never truncated. */
	trailing?: ReactNode;
}

/**
 * One row of the filter panel, in either of the two shapes it has: a switch
 * that stands alone, and a choice among several.
 *
 * Both are the same row — a 20px indicator, a label that takes what is left,
 * and nothing that pushes the label out of the panel — because a panel where
 * the two shapes were laid out differently would read as two panels.
 */
export default function FilterOption({
	label,
	description,
	checked,
	onChange,
	type = "checkbox",
	name,
	icon,
	trailing,
}: Props) {
	const id = useId();
	const descId = `${id}-desc`;

	return (
		<label
			htmlFor={id}
			className={`flex w-full cursor-pointer gap-3 px-4 py-3 text-left transition-colors hover:bg-th-bg-tertiary active:bg-th-bg-tertiary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-th-accent has-[:focus-visible]:ring-inset ${
				description ? "items-start" : "items-center"
			}`}
		>
			<input
				id={id}
				type={type}
				name={name}
				checked={checked}
				onChange={onChange}
				aria-describedby={description ? descId : undefined}
				className="sr-only"
			/>
			<span
				className={`flex h-5 w-5 shrink-0 items-center justify-center border transition-colors ${
					type === "radio" ? "rounded-full" : "rounded"
				} ${description ? "mt-0.5" : ""} ${
					checked
						? "border-th-accent bg-th-accent text-th-accent-text"
						: "border-th-border bg-transparent"
				}`}
				aria-hidden="true"
			>
				{checked &&
					(type === "radio" ? (
						<span className="h-2 w-2 rounded-full bg-th-accent-text" />
					) : (
						<Check className="h-3.5 w-3.5" strokeWidth={3} />
					))}
			</span>
			{description ? (
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-sm text-th-text-primary">{label}</span>
					<span id={descId} className="text-xs text-th-text-muted">
						{description}
					</span>
				</span>
			) : (
				<span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-th-text-primary">
					{icon}
					<span className="truncate">{label}</span>
				</span>
			)}
			{trailing && (
				<span className="shrink-0 text-xs text-th-text-muted">{trailing}</span>
			)}
		</label>
	);
}
