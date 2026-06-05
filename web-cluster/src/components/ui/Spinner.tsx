interface Props {
	className?: string;
}

export function Spinner({ className = "h-4 w-4" }: Props) {
	return (
		<span
			role="status"
			aria-label="Loading"
			className={`inline-block animate-spin rounded-full border-2 border-th-accent border-t-transparent ${className}`}
		/>
	);
}
