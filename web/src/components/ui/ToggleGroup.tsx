import { type ValueState, waitingLabel } from "../../lib/valueState";
import Skeleton from "./Skeleton";

/**
 * A segmented control that applies on tap: one segment per value, the stored
 * one lit. It carries no state of its own — `selected` is whatever the caller
 * last heard from the server, and a refused write comes back as `error`.
 */
export default function ToggleGroup<T extends string>({
	label,
	items,
	selected,
	onSelect,
	getInfo,
	hint,
	error,
	valueState = "known",
}: {
	label: string;
	items: readonly T[];
	selected: T;
	onSelect: (value: T) => void;
	getInfo: (value: T) => {
		label: string;
		icon?: React.ComponentType<{ className?: string }>;
	};
	hint?: string;
	error?: string | null;
	/**
	 * Whether `selected` is the stored value. Which segment is lit *is* the value
	 * here, so anything but `known` replaces the whole row: three segments with
	 * none lit would claim nothing is selected, and would not look like waiting.
	 * The hint goes with it, being derived from the same value.
	 */
	valueState?: ValueState;
}) {
	const hasValue = valueState === "known";

	return (
		<div className="space-y-1.5">
			{/* Uppercase, as the Engine field labels itself: wherever the two sit
			    together they are fields of one section, and a label style each
			    would read as two. */}
			<p className="text-xs font-medium uppercase text-th-text-muted">
				{label}
			</p>
			{hasValue ? (
				// biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply toggle group
				<div
					role="group"
					aria-label={label}
					className="flex gap-1 rounded-lg bg-th-bg-secondary p-1"
				>
					{items.map((item) => {
						const info = getInfo(item);
						const isSelected = selected === item;
						return (
							<button
								key={item}
								type="button"
								onClick={() => onSelect(item)}
								aria-pressed={isSelected}
								className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
									isSelected
										? "bg-th-bg-tertiary text-th-text-primary shadow-sm"
										: "text-th-text-muted hover:text-th-text-secondary"
								}`}
							>
								{info.icon && (
									<info.icon className="h-4 w-4" aria-hidden="true" />
								)}
								<span>{info.label}</span>
							</button>
						);
					})}
				</div>
			) : (
				// biome-ignore lint/a11y/useSemanticElements: the group the segments would form, kept so the row does not resize when they arrive
				<div
					role="group"
					aria-label={waitingLabel(label, valueState)}
					aria-busy={valueState === "pending"}
					className="flex gap-1 rounded-lg bg-th-bg-secondary p-1"
				>
					<Skeleton
						className="h-11 flex-1 rounded-md"
						animated={valueState === "pending"}
					/>
				</div>
			)}
			{hasValue
				? hint && (
						<p className="whitespace-pre-line text-xs text-th-text-muted">
							{hint}
						</p>
					)
				: hint !== undefined && (
						<Skeleton
							className="h-3 w-2/3 rounded"
							animated={valueState === "pending"}
						/>
					)}
			{error && (
				<p className="text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
