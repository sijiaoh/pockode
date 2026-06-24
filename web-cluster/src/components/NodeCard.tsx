import { ConfirmDialog, Spinner } from "@pockode/shared";
import { useId, useState } from "react";
import { useIsDesktop } from "../hooks";
import type { NodeStatus, NodeWithStatus } from "../types/node";
import { ResponsivePanel } from "./ui";

interface Props {
	node: NodeWithStatus;
	onEdit: (node: NodeWithStatus) => void;
	onDelete: (id: string) => void;
	onStart: (id: string, token: string) => Promise<void>;
	onStop: (id: string) => Promise<void>;
}

const statusConfig: Record<
	NodeStatus,
	{ dot: string; label: string; text: string; border: string; bg: string }
> = {
	running: {
		dot: "bg-th-success",
		label: "Running",
		text: "text-th-success",
		border: "border-th-success/30",
		bg: "bg-th-success/10",
	},
	stopped: {
		dot: "bg-th-text-muted",
		label: "Stopped",
		text: "text-th-text-secondary",
		border: "border-th-border",
		bg: "bg-th-bg-tertiary",
	},
	stale: {
		dot: "bg-th-warning",
		label: "Stale",
		text: "text-th-warning",
		border: "border-th-warning/30",
		bg: "bg-th-warning/10",
	},
};

function StatusBadge({ status }: { status: NodeStatus }) {
	const config = statusConfig[status];

	return (
		<span
			className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${config.border} ${config.bg} ${config.text}`}
		>
			<span className={`h-2 w-2 rounded-full ${config.dot}`} />
			{config.label}
		</span>
	);
}

function formatStartedAt(value?: string): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function NodeCard({ node, onEdit, onDelete, onStart, onStop }: Props) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [startPanelOpen, setStartPanelOpen] = useState(false);
	const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
	const [token, setToken] = useState("");
	const [actionLoading, setActionLoading] = useState(false);
	const isDesktop = useIsDesktop();

	const status = node.status.status;
	const displayPath = node.path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
	const startedAt = formatStartedAt(node.status.started_at);
	const primaryLabel =
		status === "stopped" ? "Start" : status === "running" ? "Stop" : "Clean Up";
	const loadingLabel =
		status === "stopped"
			? "Starting..."
			: status === "running"
				? "Stopping..."
				: "Cleaning...";

	const handleEdit = () => {
		setMenuOpen(false);
		onEdit(node);
	};

	const handleDelete = () => {
		setMenuOpen(false);
		setDeleteConfirmOpen(true);
	};

	const handlePrimaryAction = () => {
		setMenuOpen(false);
		if (status === "stopped") {
			setStartPanelOpen(true);
			return;
		}
		setStopConfirmOpen(true);
	};

	const confirmDelete = () => {
		setDeleteConfirmOpen(false);
		onDelete(node.id);
	};

	const confirmStart = async () => {
		if (!token.trim()) return;
		setActionLoading(true);
		try {
			await onStart(node.id, token.trim());
			setStartPanelOpen(false);
			setToken("");
		} finally {
			setActionLoading(false);
		}
	};

	const confirmStop = async () => {
		setActionLoading(true);
		try {
			await onStop(node.id);
			setStopConfirmOpen(false);
		} finally {
			setActionLoading(false);
		}
	};

	return (
		<>
			<div className="rounded-lg border border-th-border bg-th-bg-secondary p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="min-w-0 break-words font-medium text-th-text-primary">
								{node.name}
							</h3>
							<StatusBadge status={status} />
						</div>
						<p className="mt-1 line-clamp-2 break-words text-sm text-th-text-secondary">
							{displayPath}
						</p>
					</div>
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

				<div className="mt-3 text-sm text-th-text-secondary">
					{status === "running" && (
						<div className="space-y-2">
							<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-th-text-muted">
								{node.status.port && <span>Port {node.status.port}</span>}
								{startedAt && <span>Started {startedAt}</span>}
							</div>
							<div className="flex flex-wrap gap-2">
								{node.status.local_url && (
									<a
										href={node.status.local_url}
										target="_blank"
										rel="noopener noreferrer"
										className="min-h-[36px] rounded-lg border border-th-border px-3 py-2 text-xs font-medium text-th-accent hover:bg-th-overlay-hover"
									>
										Local
									</a>
								)}
								{node.status.remote_url ? (
									<a
										href={node.status.remote_url}
										target="_blank"
										rel="noopener noreferrer"
										className="min-h-[36px] rounded-lg border border-th-border px-3 py-2 text-xs font-medium text-th-accent hover:bg-th-overlay-hover"
									>
										Remote
									</a>
								) : (
									<span className="py-2 text-xs text-th-text-muted">
										Remote unavailable
									</span>
								)}
							</div>
						</div>
					)}
					{status === "stopped" && <p>Not running</p>}
					{status === "stale" && (
						<p className="rounded-lg border border-th-warning/30 bg-th-warning/10 px-3 py-2 text-th-warning">
							Process is gone, but server info remains.
						</p>
					)}
				</div>

				<div className="mt-4 flex gap-2">
					<button
						type="button"
						onClick={handlePrimaryAction}
						disabled={actionLoading}
						className={`flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${
							status === "stopped"
								? "bg-th-accent text-th-accent-text hover:bg-th-accent-hover"
								: status === "stale"
									? "bg-th-warning text-th-text-inverse hover:opacity-90"
									: "border border-th-error/40 text-th-error hover:bg-th-error/10"
						}`}
					>
						{actionLoading && <Spinner size="h-4 w-4" />}
						{actionLoading ? loadingLabel : primaryLabel}
					</button>
				</div>
			</div>

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
						className="flex min-h-[44px] items-center rounded-lg px-3 py-2 text-left text-th-text-primary hover:bg-th-overlay-hover"
					>
						Edit
					</button>
					<button
						type="button"
						onClick={handleDelete}
						className="flex min-h-[44px] items-center rounded-lg px-3 py-2 text-left text-th-error hover:bg-th-overlay-hover"
					>
						Delete
					</button>
				</div>
			</ResponsivePanel>

			{deleteConfirmOpen && (
				<ConfirmDialog
					title="Delete node?"
					message={`Delete "${node.name}"? This cannot be undone.`}
					confirmLabel="Delete"
					cancelLabel="Cancel"
					variant="danger"
					zIndex={50}
					onConfirm={confirmDelete}
					onCancel={() => setDeleteConfirmOpen(false)}
				/>
			)}

			{stopConfirmOpen && (
				<ConfirmDialog
					title={
						status === "stale" ? "Clean up stale state?" : `Stop ${node.name}?`
					}
					message={
						status === "stale"
							? `The recorded process for "${node.name}" is no longer running. This removes the stale server info.`
							: "This stops the Pockode server for this project."
					}
					confirmLabel={status === "stale" ? "Clean Up" : "Stop"}
					cancelLabel="Cancel"
					variant="danger"
					zIndex={50}
					onConfirm={confirmStop}
					onCancel={() => setStopConfirmOpen(false)}
				/>
			)}

			<StartNodePanel
				isOpen={startPanelOpen}
				nodeName={node.name}
				token={token}
				loading={actionLoading}
				onTokenChange={setToken}
				onConfirm={confirmStart}
				onCancel={() => {
					if (actionLoading) return;
					setStartPanelOpen(false);
					setToken("");
				}}
			/>
		</>
	);
}

interface StartNodePanelProps {
	isOpen: boolean;
	nodeName: string;
	token: string;
	loading: boolean;
	onTokenChange: (token: string) => void;
	onConfirm: () => void;
	onCancel: () => void;
}

function StartNodePanel({
	isOpen,
	nodeName,
	token,
	loading,
	onTokenChange,
	onConfirm,
	onCancel,
}: StartNodePanelProps) {
	const isDesktop = useIsDesktop();
	const inputId = useId();

	return (
		<ResponsivePanel
			isOpen={isOpen}
			onClose={onCancel}
			title={`Start ${nodeName}`}
			isDesktop={isDesktop}
		>
			<div className="flex flex-col gap-4">
				<p className="text-sm text-th-text-secondary">
					Used by the Pockode server started in this project.
				</p>
				<div>
					<label
						htmlFor={inputId}
						className="mb-1 block text-sm text-th-text-secondary"
					>
						Auth token
					</label>
					<input
						id={inputId}
						type="password"
						value={token}
						onChange={(e) => onTokenChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && token.trim() && !loading) {
								onConfirm();
							}
						}}
						disabled={loading}
						className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none disabled:opacity-50"
						autoFocus
					/>
				</div>
				<div className="flex justify-end gap-3 pt-2">
					<button
						type="button"
						onClick={onCancel}
						disabled={loading}
						className="min-h-[44px] rounded-lg border border-th-border px-4 py-2 text-sm font-medium text-th-text-primary hover:bg-th-overlay-hover disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={loading || !token.trim()}
						className="flex min-h-[44px] items-center gap-2 rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text hover:bg-th-accent-hover disabled:opacity-50"
					>
						{loading && <Spinner size="h-4 w-4" />}
						{loading ? "Starting..." : "Start"}
					</button>
				</div>
			</div>
		</ResponsivePanel>
	);
}
