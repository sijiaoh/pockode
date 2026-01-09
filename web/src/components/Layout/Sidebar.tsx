import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const SIDEBAR_WIDTH_KEY = "pockode:sidebar-width";
const MIN_WIDTH = 240;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 288; // w-72

function getInitialWidth(): number {
	const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
	if (saved) {
		const parsed = Number.parseInt(saved, 10);
		if (!Number.isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
			return parsed;
		}
	}
	return DEFAULT_WIDTH;
}

interface Props {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	children: React.ReactNode;
	isDesktop: boolean;
}

function Sidebar({ isOpen, onClose, title, children, isDesktop }: Props) {
	const [width, setWidth] = useState(getInitialWidth);
	const [isDragging, setIsDragging] = useState(false);
	const widthRef = useRef(width);

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

	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setIsDragging(true);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
	}, []);

	useEffect(() => {
		widthRef.current = width;
	}, [width]);

	useEffect(() => {
		if (!isDragging) return;

		const handleMouseMove = (e: MouseEvent) => {
			const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
			setWidth(newWidth);
		};

		const handleMouseUp = () => {
			setIsDragging(false);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			localStorage.setItem(SIDEBAR_WIDTH_KEY, widthRef.current.toString());
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging]);

	// Desktop: always visible as part of flex layout
	if (isDesktop) {
		return (
			<div
				className="relative flex h-dvh shrink-0 flex-col border-r border-th-border bg-th-bg-secondary"
				style={{ width }}
			>
				<div className="flex h-12 shrink-0 items-center border-b border-th-border px-4">
					<h2 className="text-lg font-semibold text-th-text-primary">
						{title}
					</h2>
				</div>
				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: Resize handle is mouse-only UI */}
				<div
					onMouseDown={handleMouseDown}
					className="group absolute top-0 right-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize"
				>
					<div
						className={`absolute left-1/2 h-full w-0.5 -translate-x-1/2 transition-colors group-hover:bg-th-accent ${isDragging ? "bg-th-accent" : "bg-transparent"}`}
					/>
				</div>
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
				<div className="flex h-11 shrink-0 items-center justify-between border-b border-th-border px-3">
					<h2 className="text-base font-semibold text-th-text-primary">
						{title}
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="flex h-8 w-8 items-center justify-center rounded text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
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
