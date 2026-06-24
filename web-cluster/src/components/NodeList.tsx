import { useCallback, useEffect, useRef, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import type { NodeWithStatus } from "../types/node";
import { NodeCard } from "./NodeCard";
import { NodeForm } from "./NodeForm";
import { Spinner } from "./ui";

const POLL_INTERVAL_MS = 5000;

type ActionNotice = {
	variant: "warning" | "error";
	title: string;
	message: string;
	nodeId?: string;
};

function getErrorMessage(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

function isAlreadyStoppedError(message: string) {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("node not running") ||
		normalized.includes("process not found")
	);
}

export function NodeList() {
	const { status, actions } = useWSStore();
	const [nodes, setNodes] = useState<NodeWithStatus[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const [editingNode, setEditingNode] = useState<NodeWithStatus | null>(null);
	const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const counts = nodes.reduce(
		(acc, node) => {
			acc.total += 1;
			acc[node.status.status] += 1;
			return acc;
		},
		{ running: 0, stale: 0, stopped: 0, total: 0 },
	);

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

	useEffect(() => {
		if (status !== "connected" || loading) return;

		let isMounted = true;

		const poll = () => {
			pollTimerRef.current = setTimeout(async () => {
				if (!isMounted) return;
				await fetchNodes();
				if (isMounted) {
					poll();
				}
			}, POLL_INTERVAL_MS);
		};
		poll();

		return () => {
			isMounted = false;
			if (pollTimerRef.current) {
				clearTimeout(pollTimerRef.current);
				pollTimerRef.current = null;
			}
		};
	}, [status, loading, fetchNodes]);

	// Keep warnings visible until the user closes them.
	useEffect(() => {
		if (actionNotice?.variant === "error") {
			const timer = setTimeout(() => setActionNotice(null), 5000);
			return () => clearTimeout(timer);
		}
	}, [actionNotice]);

	const handleAdd = () => {
		setEditingNode(null);
		setFormOpen(true);
	};

	const handleEdit = (node: NodeWithStatus) => {
		setEditingNode(node);
		setFormOpen(true);
	};

	const handleDelete = async (id: string) => {
		try {
			await actions.deleteNode(id);
			setNodes((prev) => prev.filter((n) => n.id !== id));
			setActionNotice(null);
		} catch (err) {
			setActionNotice({
				variant: "error",
				title: "Could not delete node",
				message: getErrorMessage(err, "Failed to delete node"),
				nodeId: id,
			});
		}
	};

	const handleSubmit = async (path: string, name?: string) => {
		if (editingNode) {
			await actions.updateNode({
				id: editingNode.id,
				path,
				name,
			});
		} else {
			await actions.createNode({ path, name });
		}
		await fetchNodes();
		setActionNotice(null);
	};

	const handleStart = async (id: string, token: string) => {
		const node = nodes.find((n) => n.id === id);
		try {
			await actions.startNode({ id, token });
			await fetchNodes();
			setActionNotice(null);
		} catch (err) {
			const message = getErrorMessage(err, "Failed to start node");
			setActionNotice({
				variant: "error",
				title: "Could not start node",
				message: `Could not start ${node?.name ?? "node"}: ${message}`,
				nodeId: id,
			});
		}
	};

	const handleStop = async (id: string) => {
		const node = nodes.find((n) => n.id === id);
		try {
			await actions.stopNode({ id });
			await fetchNodes();
			setActionNotice(null);
		} catch (err) {
			const message = getErrorMessage(err, "Failed to stop node");
			await fetchNodes();
			if (isAlreadyStoppedError(message)) {
				setActionNotice({
					variant: "warning",
					title: "Node was already stopped",
					message:
						"Process was already gone. Stale server info was cleaned up.",
					nodeId: id,
				});
				return;
			}
			setActionNotice({
				variant: "error",
				title: "Could not stop node",
				message: `Could not stop ${node?.name ?? "node"}: ${message}`,
				nodeId: id,
			});
		}
	};

	if (loading && status === "connected") {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner size="h-8 w-8" />
			</div>
		);
	}

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
			<header className="flex min-h-14 shrink-0 items-center justify-between border-b border-th-border px-4 py-2">
				<div>
					<h1 className="text-lg font-semibold text-th-text-primary">
						Cluster
					</h1>
					<p
						className={`text-xs ${
							status === "reconnecting" ? "text-th-warning" : "text-th-success"
						}`}
					>
						{status === "reconnecting" ? "Reconnecting..." : "Connected"}
					</p>
				</div>
				<button
					type="button"
					onClick={handleAdd}
					className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-lg bg-th-accent px-3 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover"
					aria-label="Add node"
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
					<span className="hidden sm:inline">Add node</span>
				</button>
			</header>

			<div className="flex-1 overflow-y-auto p-4">
				{status === "reconnecting" && (
					<div className="mb-3 rounded-lg border border-th-warning/30 bg-th-warning/10 px-3 py-2 text-sm text-th-warning">
						Reconnecting. Showing the last known state.
					</div>
				)}

				<div className="mb-3 flex flex-wrap gap-2">
					<SummaryChip label={`${counts.running} running`} />
					<SummaryChip label={`${counts.stopped} stopped`} />
					<SummaryChip
						label={
							counts.stale > 0
								? `${counts.stale} needs cleanup`
								: `${counts.stale} stale`
						}
						variant={counts.stale > 0 ? "warning" : "default"}
					/>
					<SummaryChip label={`${counts.total} nodes`} />
				</div>

				{actionNotice && (
					<div
						className={`mb-3 rounded-lg border px-4 py-3 text-sm ${
							actionNotice.variant === "warning"
								? "border-th-warning/30 bg-th-warning/10 text-th-warning"
								: "border-th-error/30 bg-th-error/10 text-th-error"
						}`}
						role="alert"
					>
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="font-medium">{actionNotice.title}</p>
								<p className="mt-1 break-words">{actionNotice.message}</p>
							</div>
							<button
								type="button"
								onClick={() => setActionNotice(null)}
								className="min-h-[32px] shrink-0 rounded px-2 text-xs hover:bg-th-overlay-hover"
							>
								Close
							</button>
						</div>
					</div>
				)}

				{nodes.length === 0 ? (
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
							No nodes
						</h2>
						<p className="mt-1 text-sm text-th-text-secondary">
							Add a project directory to run Pockode from this cluster.
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
							Add node
						</button>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						{nodes.map((node) => (
							<NodeCard
								key={node.id}
								node={node}
								onEdit={handleEdit}
								onDelete={handleDelete}
								onStart={handleStart}
								onStop={handleStop}
							/>
						))}
					</div>
				)}
			</div>

			<NodeForm
				isOpen={formOpen}
				onClose={() => setFormOpen(false)}
				onSubmit={handleSubmit}
				editingNode={editingNode}
			/>
		</div>
	);
}

function SummaryChip({
	label,
	variant = "default",
}: {
	label: string;
	variant?: "default" | "warning";
}) {
	return (
		<span
			className={`rounded-full border px-2.5 py-1 text-xs ${
				variant === "warning"
					? "border-th-warning/30 bg-th-warning/10 text-th-warning"
					: "border-th-border bg-th-bg-secondary text-th-text-secondary"
			}`}
		>
			{label}
		</span>
	);
}
