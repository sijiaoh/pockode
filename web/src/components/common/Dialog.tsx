import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface DialogProps {
	title: string;
	onClose: () => void;
	children: ReactNode;
	/** Max width class. Defaults to "max-w-md" */
	maxWidth?: string;
}

/**
 * Reusable modal dialog with portal, escape key, backdrop click, and scroll lock.
 */
function Dialog({
	title,
	onClose,
	children,
	maxWidth = "max-w-md",
}: DialogProps) {
	const titleId = useId();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onCloseRef.current();
			}
		};

		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.body.style.overflow = originalOverflow;
		};
	}, []);

	const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation();

	return createPortal(
		/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled in useEffect */
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-th-bg-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onClick={stopEvent}
			onMouseDown={stopEvent}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop */}
			<div className="absolute inset-0" onClick={onClose} />
			<div
				className={`relative mx-4 w-full ${maxWidth} rounded-lg bg-th-bg-secondary p-4 shadow-xl`}
			>
				<h2 id={titleId} className="text-lg font-bold text-th-text-primary">
					{title}
				</h2>
				{children}
			</div>
		</div>,
		document.body,
	);
}

export default Dialog;
