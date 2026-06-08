import { ConfirmDialog } from "@pockode/shared";
import { useState } from "react";
import { useIsDesktop } from "../hooks";
import type { Node } from "../types/node";
import { ResponsivePanel } from "./ui";

interface Props {
	node: Node;
	onEdit: (node: Node) => void;
	onDelete: (id: string) => void;
}

export function NodeCard({ node, onEdit, onDelete }: Props) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const isDesktop = useIsDesktop();

	const handleDelete = () => {
		setMenuOpen(false);
		setDeleteConfirmOpen(true);
	};

	const confirmDelete = () => {
		setDeleteConfirmOpen(false);
		onDelete(node.id);
	};

	const handleEdit = () => {
		setMenuOpen(false);
		onEdit(node);
	};

	// Shorten path for display (use ~ for home directory)
	// Handles both macOS (/Users/xxx) and Linux (/home/xxx)
	const displayPath = node.path.replace(/^\/(?:Users|home)\/[^/]+/, "~");

	return (
		<>
			<div className="flex items-center gap-3 rounded-lg border border-th-border bg-th-bg-secondary px-4 py-3 hover:bg-th-bg-tertiary">
				{/* Folder icon */}
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-th-bg-tertiary text-th-text-secondary">
					<svg
						className="h-5 w-5"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.5}
							d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
						/>
					</svg>
				</div>

				{/* Content */}
				<div className="min-w-0 flex-1">
					<h3 className="truncate font-medium text-th-text-primary">
						{node.name}
					</h3>
					<p className="truncate text-sm text-th-text-secondary">
						{displayPath}
					</p>
				</div>

				{/* Menu button */}
				<button
					type="button"
					onClick={() => setMenuOpen(true)}
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-th-text-secondary hover:bg-th-overlay-hover hover:text-th-text-primary"
					aria-label="More options"
				>
					<svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
						<circle cx="12" cy="6" r="1.5" />
						<circle cx="12" cy="12" r="1.5" />
						<circle cx="12" cy="18" r="1.5" />
					</svg>
				</button>
			</div>

			{/* Action menu */}
			<ResponsivePanel
				isOpen={menuOpen}
				onClose={() => setMenuOpen(false)}
				title={node.name}
				isDesktop={isDesktop}
			>
				<div className="flex flex-col gap-1">
					<button
						type="button"
						onClick={handleEdit}
						className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-th-text-primary hover:bg-th-overlay-hover"
					>
						<svg
							className="h-5 w-5 text-th-text-secondary"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
								d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
							/>
						</svg>
						Edit
					</button>
					<button
						type="button"
						onClick={handleDelete}
						className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-th-error hover:bg-th-overlay-hover"
					>
						<svg
							className="h-5 w-5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
								d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
							/>
						</svg>
						Delete
					</button>
				</div>
			</ResponsivePanel>

			{/* Delete confirmation */}
			{deleteConfirmOpen && (
				<ConfirmDialog
					title="Delete Node?"
					message={`Are you sure you want to delete "${node.name}"? This action cannot be undone.`}
					confirmLabel="Delete"
					cancelLabel="Cancel"
					variant="danger"
					zIndex={50}
					onConfirm={confirmDelete}
					onCancel={() => setDeleteConfirmOpen(false)}
				/>
			)}
		</>
	);
}
