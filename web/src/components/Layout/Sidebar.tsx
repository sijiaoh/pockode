import { X } from "lucide-react";
import { useEffect } from "react";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
	isDesktop: boolean;
}

function Sidebar({ isOpen, onClose, title, children, isDesktop }: Props) {
	// Close on Escape key (mobile only)
	useEffect(() => {
		if (isDesktop) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isOpen) {
				onClose();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, onClose, isDesktop]);

	// Desktop: always visible as part of flex layout
	if (isDesktop) {
		return (
			<div className="flex h-dvh w-72 shrink-0 flex-col border-r border-th-border bg-th-bg-secondary">
				<div className="flex items-center border-b border-th-border p-4">
					<h2 className="font-semibold text-th-text-primary">{title}</h2>
				</div>
				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
			</div>
		);
	}

	// Mobile: overlay drawer
	if (!isOpen) return null;

	return (
		<>
			<button
				type="button"
				className="fixed inset-0 z-40 bg-th-bg-overlay"
				onClick={onClose}
				aria-label="Close sidebar"
			/>

			<div className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-th-bg-secondary">
				<div className="flex items-center justify-between border-b border-th-border p-4">
					<h2 className="font-semibold text-th-text-primary">{title}</h2>
					<button
						type="button"
						onClick={onClose}
						className="rounded p-1 text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
						aria-label="Close sidebar"
					>
						<X className="h-5 w-5" aria-hidden="true" />
					</button>
				</div>

				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
			</div>
		</>
	);
}

export default Sidebar;
