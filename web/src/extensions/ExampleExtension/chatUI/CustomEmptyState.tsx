import type { EmptyStateProps } from "../../../lib/registries/chatUIRegistry";

export default function CustomEmptyState({ onHintClick }: EmptyStateProps) {
	const hints = [
		"What can you help me with?",
		"Show me some examples",
		"How do I get started?",
	];

	return (
		<div className="flex flex-col items-center justify-center gap-4 p-8 text-center flex-1">
			<div className="text-4xl">👋</div>
			<h2 className="text-xl font-semibold th-text-primary">
				Welcome to Custom Chat!
			</h2>
			<p className="th-text-secondary">
				This is a custom empty state from the CustomChatUI extension.
			</p>
			{onHintClick && (
				<div className="flex flex-wrap justify-center gap-2">
					{hints.map((hint) => (
						<button
							key={hint}
							type="button"
							onClick={() => onHintClick(hint)}
							className="rounded-full px-4 py-2 text-sm th-bg-secondary th-text-primary hover:opacity-80"
						>
							{hint}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
