import { useEffect, useMemo, useRef } from "react";
import type { Command } from "../../lib/rpc";

interface Props {
	commands: Command[];
	filter: string;
	selectedIndex: number;
	onSelect: (command: Command) => void;
}

function CommandPalette({ commands, filter, selectedIndex, onSelect }: Props) {
	const selectedRef = useRef<HTMLButtonElement>(null);

	const filtered = useMemo(() => {
		if (!filter) return commands;
		const lower = filter.toLowerCase();
		return commands.filter((cmd) => cmd.name.toLowerCase().includes(lower));
	}, [commands, filter]);

	// Scroll selected item into view
	useEffect(() => {
		selectedRef.current?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	return (
		<div
			className="absolute bottom-full left-0 right-0 z-10 mx-3 mb-2 max-h-[40vh] overflow-y-auto rounded-xl border border-th-border bg-th-bg-secondary shadow-lg sm:mx-4"
			role="listbox"
		>
			{filtered.length === 0 ? (
				<div className="px-4 py-3 text-th-text-muted">No matching commands</div>
			) : (
				filtered.map((cmd, index) => (
					<button
						key={cmd.name}
						ref={index === selectedIndex ? selectedRef : null}
						type="button"
						onClick={() => onSelect(cmd)}
						className={`flex w-full items-center gap-3 px-4 py-3 text-left ${
							index === selectedIndex
								? "bg-th-bg-tertiary"
								: "hover:bg-th-bg-tertiary active:bg-th-bg-tertiary"
						}`}
						role="option"
						aria-selected={index === selectedIndex}
					>
						<span className="font-medium text-th-text-primary">/{cmd.name}</span>
						{!cmd.isBuiltin && (
							<span className="text-sm text-th-text-muted">(custom)</span>
						)}
					</button>
				))
			)}
		</div>
	);
}

export default CommandPalette;

export function useFilteredCommands(commands: Command[], filter: string): Command[] {
	return useMemo(() => {
		if (!filter) return commands;
		const lower = filter.toLowerCase();
		return commands.filter((cmd) => cmd.name.toLowerCase().includes(lower));
	}, [commands, filter]);
}
