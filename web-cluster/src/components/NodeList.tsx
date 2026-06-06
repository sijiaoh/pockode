import { useCallback, useEffect, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import type { Node } from "../types/node";
import { NodeCard } from "./NodeCard";
import { NodeForm } from "./NodeForm";
import { Spinner } from "./ui";

export function NodeList() {
	const { status, actions } = useWSStore();
	const [nodes, setNodes] = useState<Node[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const [editingNode, setEditingNode] = useState<Node | null>(null);

	const fetchNodes = useCallback(async () => {
		if (status !== "connected") return;

		try {
			const result = await actions.listNodes();
			setNodes(result);
			setLoadError(null);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : "Failed to load nodes");
		} finally {
			setLoading(false);
		}
	}, [status, actions]);

	useEffect(() => {
		if (status === "connected") {
			fetchNodes();
		}
	}, [status, fetchNodes]);

	// Auto-dismiss action errors after 5 seconds
	useEffect(() => {
		if (actionError) {
			const timer = setTimeout(() => setActionError(null), 5000);
			return () => clearTimeout(timer);
		}
	}, [actionError]);

	const handleAdd = () => {
		setEditingNode(null);
		setFormOpen(true);
	};

	const handleEdit = (node: Node) => {
		setEditingNode(node);
		setFormOpen(true);
	};

	const handleDelete = async (id: string) => {
		try {
			await actions.deleteNode(id);
			setNodes((prev) => prev.filter((n) => n.id !== id));
			setActionError(null);
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : "Failed to delete node",
			);
		}
	};

	const handleSubmit = async (path: string, name?: string) => {
		if (editingNode) {
			const updated = await actions.updateNode({
				id: editingNode.id,
				path,
				name,
			});
			setNodes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
		} else {
			const created = await actions.createNode({ path, name });
			setNodes((prev) => [...prev, created]);
		}
	};

	// Loading state
	if (loading && status === "connected") {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	// Load error state
	if (loadError) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
				<div className="text-th-error">{loadError}</div>
				<button
					type="button"
					onClick={fetchNodes}
					className="min-h-[44px] rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
				>
					Retry
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col">
			{/* Action error toast */}
			{actionError && (
				<div className="absolute left-4 right-4 top-16 z-40 rounded-lg border border-th-error/30 bg-th-error/10 px-4 py-3 text-sm text-th-error">
					{actionError}
				</div>
			)}

			{/* Header */}
			<header className="flex h-14 shrink-0 items-center justify-between border-b border-th-border px-4">
				<h1 className="text-lg font-semibold text-th-text-primary">Nodes</h1>
				<button
					type="button"
					onClick={handleAdd}
					className="flex min-h-[44px] items-center gap-2 rounded-lg bg-th-accent px-3 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
				>
					<svg
						className="h-4 w-4"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M12 4v16m8-8H4"
						/>
					</svg>
					Add
				</button>
			</header>

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-4">
				{nodes.length === 0 ? (
					// Empty state
					<div className="flex flex-col items-center justify-center py-16 text-center">
						<div className="flex h-16 w-16 items-center justify-center rounded-full bg-th-bg-tertiary text-th-text-muted">
							<svg
								className="h-8 w-8"
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
						<h2 className="mt-4 text-lg font-medium text-th-text-primary">
							No nodes yet
						</h2>
						<p className="mt-1 text-sm text-th-text-secondary">
							Add a project to get started
						</p>
						<button
							type="button"
							onClick={handleAdd}
							className="mt-6 flex min-h-[44px] items-center gap-2 rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
						>
							<svg
								className="h-4 w-4"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M12 4v16m8-8H4"
								/>
							</svg>
							Add Node
						</button>
					</div>
				) : (
					// Node list
					<div className="flex flex-col gap-3">
						{nodes.map((node) => (
							<NodeCard
								key={node.id}
								node={node}
								onEdit={handleEdit}
								onDelete={handleDelete}
							/>
						))}
					</div>
				)}
			</div>

			{/* Form panel */}
			<NodeForm
				isOpen={formOpen}
				onClose={() => setFormOpen(false)}
				onSubmit={handleSubmit}
				editingNode={editingNode}
			/>
		</div>
	);
}
