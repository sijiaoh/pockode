import { ArrowLeft } from "lucide-react";

interface Props {
	onClick: () => void;
	"aria-label": string;
}

export default function BackButton({
	onClick,
	"aria-label": ariaLabel,
}: Props) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-th-border bg-th-bg-tertiary p-2 text-th-text-secondary transition-all hover:border-th-border-focus hover:text-th-text-primary active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			aria-label={ariaLabel}
		>
			<ArrowLeft className="h-5 w-5" aria-hidden="true" />
		</button>
	);
}
