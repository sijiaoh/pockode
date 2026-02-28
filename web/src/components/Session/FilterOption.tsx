import { Check } from "lucide-react";
import { useId } from "react";

interface Props {
	label: string;
	description: string;
	checked: boolean;
	onChange: () => void;
}

export default function FilterOption({
	label,
	description,
	checked,
	onChange,
}: Props) {
	const id = useId();
	const descId = `${id}-desc`;

	return (
		<label
			htmlFor={id}
			className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-th-bg-tertiary active:bg-th-bg-tertiary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-th-accent has-[:focus-visible]:ring-inset"
		>
			<input
				id={id}
				type="checkbox"
				checked={checked}
				onChange={onChange}
				aria-describedby={descId}
				className="sr-only"
			/>
			<span
				className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
					checked
						? "border-th-accent bg-th-accent text-white"
						: "border-th-border bg-transparent"
				}`}
				aria-hidden="true"
			>
				{checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
			</span>
			<span className="flex flex-col gap-0.5">
				<span className="text-sm text-th-text-primary">{label}</span>
				<span id={descId} className="text-xs text-th-text-muted">
					{description}
				</span>
			</span>
		</label>
	);
}
