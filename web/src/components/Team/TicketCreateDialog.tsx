import { useEffect, useRef, useState } from "react";
import { useRoleStore } from "../../lib/roleStore";
import Dialog from "../common/Dialog";

interface Props {
	onSubmit: (data: {
		title: string;
		description: string;
		roleId: string;
	}) => void;
	onCancel: () => void;
}

function TicketCreateDialog({ onSubmit, onCancel }: Props) {
	const roles = useRoleStore((s) => s.roles);
	const titleInputRef = useRef<HTMLInputElement>(null);

	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [roleId, setRoleId] = useState(() => roles[0]?.id ?? "");

	useEffect(() => {
		titleInputRef.current?.focus();
	}, []);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!title.trim() || !roleId) return;
		onSubmit({ title: title.trim(), description: description.trim(), roleId });
	};

	const isValid = title.trim() && roleId;

	return (
		<Dialog title="Create Ticket" onClose={onCancel}>
			<form onSubmit={handleSubmit} className="mt-4 space-y-4">
				<div>
					<label
						htmlFor="ticket-title"
						className="block text-sm font-medium text-th-text-primary mb-1"
					>
						Title
					</label>
					<input
						ref={titleInputRef}
						id="ticket-title"
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="What needs to be done?"
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
					/>
				</div>

				<div>
					<label
						htmlFor="ticket-description"
						className="block text-sm font-medium text-th-text-primary mb-1"
					>
						Description
					</label>
					<textarea
						id="ticket-description"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="Provide more details..."
						rows={4}
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none resize-none"
					/>
				</div>

				<div>
					<label
						htmlFor="ticket-role"
						className="block text-sm font-medium text-th-text-primary mb-1"
					>
						Agent Role
					</label>
					<select
						id="ticket-role"
						value={roleId}
						onChange={(e) => setRoleId(e.target.value)}
						className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary focus:border-th-accent focus:outline-none"
					>
						{roles.map((role) => (
							<option key={role.id} value={role.id}>
								{role.name}
							</option>
						))}
					</select>
				</div>

				<div className="flex justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={onCancel}
						className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-text-primary transition-colors hover:opacity-90"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!isValid}
						className="rounded-lg bg-th-accent px-4 py-2 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Create
					</button>
				</div>
			</form>
		</Dialog>
	);
}

export default TicketCreateDialog;
