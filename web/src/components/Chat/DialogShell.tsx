import { type ReactNode, useEffect, useRef } from "react";

interface Action {
	label: string;
	onClick: () => void;
	variant: "primary" | "secondary" | "success";
}

interface Props {
	title: string;
	description: string;
	children: ReactNode;
	actions: Action[];
	onClose: () => void;
}

const variantStyles = {
	primary: "bg-th-accent text-th-accent-text hover:bg-th-accent-hover",
	secondary: "bg-th-bg-tertiary text-th-text-primary hover:opacity-90",
	success: "bg-th-success text-th-text-inverse hover:opacity-90",
};

function DialogShell({
	title,
	description,
	children,
	actions,
	onClose,
}: Props) {
	const primaryButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		primaryButtonRef.current?.focus();

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const primaryActionIndex = actions.findIndex((a) => a.variant === "primary");

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-th-bg-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby="dialog-title"
		>
			<div className="mx-4 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-th-bg-secondary shadow-xl">
				<div className="border-b border-th-border p-4">
					<h2
						id="dialog-title"
						className="text-lg font-semibold text-th-text-primary"
					>
						{title}
					</h2>
					<p className="mt-1 text-sm text-th-text-muted">{description}</p>
				</div>

				<div className="flex-1 overflow-y-auto p-4">{children}</div>

				<div className="flex justify-end gap-3 border-t border-th-border p-4">
					{actions.map((action, idx) => (
						<button
							key={action.label}
							ref={idx === primaryActionIndex ? primaryButtonRef : undefined}
							type="button"
							onClick={action.onClick}
							className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${variantStyles[action.variant]}`}
						>
							{action.label}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

export default DialogShell;
