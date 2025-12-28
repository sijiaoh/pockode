import { useEffect } from "react";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
}

function Sidebar({ isOpen, onClose, title, children }: Props) {
	// Close on Escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isOpen) {
				onClose();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, onClose]);

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
						<svg
							className="h-5 w-5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
			</div>
		</>
	);
}

export default Sidebar;
