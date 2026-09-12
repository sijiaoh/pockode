import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useSidebarRefresh } from "../../../components/Layout";

export default function NotesTab() {
	const { isActive } = useSidebarRefresh("notes");
	const [notes, setNotes] = useState<string[]>([]);
	const [input, setInput] = useState("");

	const handleAdd = () => {
		const text = input.trim();
		if (text) {
			setNotes((prev) => [...prev, text]);
			setInput("");
		}
	};

	const handleRemove = (index: number) => {
		setNotes((prev) => prev.filter((_, i) => i !== index));
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleAdd();
		}
	};

	return (
		<div className={isActive ? "flex flex-col gap-3 p-4" : "hidden"}>
			<div className="flex gap-2">
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Add a note..."
					className="flex-1 rounded border border-th-border bg-th-bg-primary px-3 py-1.5 text-sm text-th-text-primary placeholder:text-th-text-muted focus:outline-none focus:ring-1 focus:ring-th-accent"
				/>
				<button
					type="button"
					onClick={handleAdd}
					disabled={!input.trim()}
					className="flex size-9 items-center justify-center rounded bg-th-accent text-th-accent-text disabled:opacity-50 pointer-coarse:size-11"
					aria-label="Add note"
				>
					<Plus className="size-4" />
				</button>
			</div>
			{notes.length === 0 ? (
				<p className="py-6 text-center text-xs text-th-text-muted">
					No notes yet. Add one above.
				</p>
			) : (
				<ul className="space-y-2">
					{notes.map((note, i) => (
						<li
							key={`${i}-${note}`}
							className="flex items-start gap-2 rounded-lg bg-th-bg-secondary p-3"
						>
							<span className="flex-1 text-sm text-th-text-primary">
								{note}
							</span>
							<button
								type="button"
								onClick={() => handleRemove(i)}
								className="flex size-9 shrink-0 items-center justify-center text-th-text-muted hover:text-th-error pointer-coarse:size-11"
								aria-label="Remove note"
							>
								<Trash2 className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
