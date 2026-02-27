import { useEffect, useState } from "react";
import { SESSION_MODE_INFO, SESSION_MODES } from "../../lib/sessionMode";
import type { SessionMode } from "../../types/message";

interface Props {
	mode: SessionMode;
	onModeChange: (mode: SessionMode) => Promise<void>;
	disabled?: boolean;
}

const ICON_COLORS: Record<
	SessionMode,
	{ iconColor: string; labelColor: string }
> = {
	default: {
		iconColor: "text-th-text-secondary group-hover:text-th-text-primary",
		labelColor: "text-th-text-primary",
	},
	yolo: {
		iconColor: "text-th-warning",
		labelColor: "text-th-warning",
	},
};

function ModeSelector({ mode, onModeChange, disabled = false }: Props) {
	const [isOpen, setIsOpen] = useState(false);

	const handleSelect = async (newMode: SessionMode) => {
		if (newMode !== mode) {
			try {
				await onModeChange(newMode);
			} catch {
				// Error already logged in useChatMessages
			}
		}
		setIsOpen(false);
	};

	const currentInfo = SESSION_MODE_INFO[mode] ?? SESSION_MODE_INFO.default;
	const currentColors = ICON_COLORS[mode] ?? ICON_COLORS.default;

	// Close dropdown on Escape key
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setIsOpen(false);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isOpen]);

	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				disabled={disabled}
				className="group flex items-center justify-center rounded border border-th-border bg-th-bg-tertiary h-8 w-8 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 hover:border-th-border-focus disabled:pointer-events-none disabled:opacity-50"
				aria-label={currentInfo.label}
			>
				<currentInfo.icon
					className={`h-4 w-4 ${currentColors.iconColor}`}
					aria-hidden="true"
				/>
			</button>

			{isOpen && (
				<>
					{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: backdrop for dropdown close, Escape key handled via useEffect */}
					<div
						className="fixed inset-0 z-40"
						onClick={() => setIsOpen(false)}
					/>
					<div className="absolute bottom-full left-0 z-50 mb-1 min-w-52 overflow-hidden rounded-lg border border-th-border bg-th-bg-secondary shadow-lg">
						{SESSION_MODES.map((modeKey) => {
							const info = SESSION_MODE_INFO[modeKey];
							const colors = ICON_COLORS[modeKey];
							const isSelected = mode === modeKey;
							return (
								<button
									key={modeKey}
									type="button"
									onClick={() => handleSelect(modeKey)}
									className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${
										isSelected ? "bg-th-accent/15" : "hover:bg-th-bg-tertiary"
									}`}
								>
									<div
										className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded-full border-2 ${
											isSelected
												? "border-th-accent bg-th-accent"
												: "border-th-text-muted"
										}`}
									>
										{isSelected && (
											<svg
												className="h-full w-full text-th-accent-text"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth={3}
											>
												<title>Selected</title>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													d="M5 13l4 4L19 7"
												/>
											</svg>
										)}
									</div>
									<div className="flex-1">
										<div
											className={`flex items-center gap-1.5 text-sm font-medium ${colors.labelColor}`}
										>
											<info.icon className="h-3.5 w-3.5" aria-hidden="true" />
											{info.label}
										</div>
										<div className="mt-0.5 whitespace-pre text-xs text-th-text-muted">
											{info.description}
										</div>
									</div>
								</button>
							);
						})}
					</div>
				</>
			)}
		</div>
	);
}

export default ModeSelector;
