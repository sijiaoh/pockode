import { useEffect, useMemo, useRef } from "react";
import type { Command } from "../../lib/rpc";
import { hasCoarsePointer } from "../../utils/breakpoints";

interface Props {
	commands: Command[];
	selectedIndex: number;
	onSelect: (command: Command) => void;
	filter: string;
}

function CommandPalette({ commands, selectedIndex, onSelect, filter }: Props) {
	const selectedRef = useRef<HTMLButtonElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when selection changes
	useEffect(() => {
		selectedRef.current?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	return (
		<div
			className="absolute bottom-full left-0 right-0 z-10 mx-3 mb-2 flex max-h-[40vh] flex-col rounded-xl border border-th-border bg-th-bg-secondary shadow-lg sm:mx-4"
			role="listbox"
		>
			{commands.length === 0 ? (
				<div className="px-4 py-3 text-th-text-muted">No matching commands</div>
			) : (
				<div className="overflow-y-auto">
					{commands.map((cmd, index) => (
						<button
							key={cmd.name}
							ref={index === selectedIndex ? selectedRef : null}
							type="button"
							onClick={() => onSelect(cmd)}
							className={`flex w-full items-center gap-3 px-4 py-3 text-left ${
								index === selectedIndex
									? "bg-th-accent/15"
									: "hover:bg-th-bg-tertiary active:bg-th-bg-tertiary"
							}`}
							role="option"
							aria-selected={index === selectedIndex}
						>
							<span className="font-medium text-th-text-primary">
								/<HighlightedText text={cmd.name} highlight={filter} />
							</span>
							{!cmd.isBuiltin && (
								<span className="text-sm text-th-text-muted">(custom)</span>
							)}
						</button>
					))}
				</div>
			)}
			{commands.length > 0 && !hasCoarsePointer() && (
				<div className="flex shrink-0 gap-3 border-t border-th-border px-4 py-2 text-xs text-th-text-muted">
					<span>
						<kbd className="rounded bg-th-bg-tertiary px-1.5 py-0.5">↑</kbd>
						<kbd className="ml-1 rounded bg-th-bg-tertiary px-1.5 py-0.5">
							↓
						</kbd>{" "}
						navigate
					</span>
					<span>
						<kbd className="rounded bg-th-bg-tertiary px-1.5 py-0.5">Tab</kbd>
						<kbd className="ml-1 rounded bg-th-bg-tertiary px-1.5 py-0.5">
							Enter
						</kbd>{" "}
						select
					</span>
					<span>
						<kbd className="rounded bg-th-bg-tertiary px-1.5 py-0.5">Esc</kbd>{" "}
						close
					</span>
				</div>
			)}
		</div>
	);
}

function HighlightedText({
	text,
	highlight,
}: {
	text: string;
	highlight: string;
}) {
	if (!highlight) return <>{text}</>;

	const lowerText = text.toLowerCase();
	const lowerHighlight = highlight.toLowerCase();
	const index = lowerText.indexOf(lowerHighlight);

	if (index === -1) return <>{text}</>;

	const before = text.slice(0, index);
	const match = text.slice(index, index + highlight.length);
	const after = text.slice(index + highlight.length);

	return (
		<>
			{before}
			<span className="text-th-accent">{match}</span>
			{after}
		</>
	);
}

export default CommandPalette;

export function useFilteredCommands(
	commands: Command[],
	filter: string,
): Command[] {
	return useMemo(() => {
		if (!filter) return commands;
		const lower = filter.toLowerCase();
		return commands.filter((cmd) => cmd.name.toLowerCase().includes(lower));
	}, [commands, filter]);
}
