import { ConfirmDialog, Spinner } from "@pockode/shared";
import { useState } from "react";
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

function StatusIndicator({ status }: { status: NodeStatus }) {
	const config = {
		running: { color: "bg-green-500", label: "Running" },
		stopped: { color: "bg-gray-400", label: "Stopped" },
		stale: { color: "bg-yellow-500", label: "Stale" },
	};
	const { color, label } = config[status];

	return (
		<div className="flex items-center gap-1.5">
			<div className={`h-2 w-2 rounded-full ${color}`} />
			<span className="text-xs text-th-text-secondary">{label}</span>
		</div>
	);
}

export function NodeCard({ node, onEdit, onDelete, onStart, onStop }: Props) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
	const [startDialogOpen, setStartDialogOpen] = useState(false);
	const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
	const [token, setToken] = useState("");
	const [actionLoading, setActionLoading] = useState(false);
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

	const handleStartClick = () => {
		setMenuOpen(false);
		setStartDialogOpen(true);
	};

	const handleStopClick = () => {
		setMenuOpen(false);
		setStopConfirmOpen(true);
	};

	const confirmStart = async () => {
		setActionLoading(true);
		try {
			await onStart(node.id, token);
			setStartDialogOpen(false);
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

	const status = node.status.status;

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
					<div className="flex items-center gap-2">
						<h3 className="truncate font-medium text-th-text-primary">
							{node.name}
						</h3>
						<StatusIndicator status={status} />
					</div>
					<p className="truncate text-sm text-th-text-secondary">
						{displayPath}
					</p>
					{status === "running" && node.status.local_url && (
						<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
							<a
								href={node.status.local_url}
								target="_blank"
								rel="noopener noreferrer"
								className="text-th-accent hover:underline"
							>
								Local
							</a>
							{node.status.remote_url && (
								<a
									href={node.status.remote_url}
									target="_blank"
									rel="noopener noreferrer"
									className="text-th-accent hover:underline"
								>
									Remote
								</a>
							)}
						</div>
					)}
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
					{/* Start/Stop button based on status */}
					{status === "stopped" && (
						<button
							type="button"
							onClick={handleStartClick}
							className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-green-600 hover:bg-th-overlay-hover"
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
									d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
								/>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={1.5}
									d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							Start
						</button>
					)}
					{status === "running" && (
						<button
							type="button"
							onClick={handleStopClick}
							className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-orange-600 hover:bg-th-overlay-hover"
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
									d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={1.5}
									d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
								/>
							</svg>
							Stop
						</button>
					)}
					{status === "stale" && (
						<button
							type="button"
							onClick={handleStopClick}
							className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-yellow-600 hover:bg-th-overlay-hover"
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
									d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
								/>
							</svg>
							Clean Up
						</button>
					)}

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

			{/* Stop confirmation */}
			{stopConfirmOpen && (
				<ConfirmDialog
					title={status === "stale" ? "Clean Up Node?" : "Stop Node?"}
					message={
						status === "stale"
							? `The node "${node.name}" has stale state. This will clean up the stale process info.`
							: `Are you sure you want to stop "${node.name}"?`
					}
					confirmLabel={status === "stale" ? "Clean Up" : "Stop"}
					cancelLabel="Cancel"
					variant="danger"
					zIndex={50}
					onConfirm={confirmStop}
					onCancel={() => setStopConfirmOpen(false)}
				/>
			)}

			{/* Start dialog */}
			{startDialogOpen && (
				<StartNodeDialog
					nodeName={node.name}
					token={token}
					onTokenChange={setToken}
					loading={actionLoading}
					onConfirm={confirmStart}
					onCancel={() => {
						setStartDialogOpen(false);
						setToken("");
					}}
				/>
			)}
		</>
	);
}

interface StartNodeDialogProps {
	nodeName: string;
	token: string;
	onTokenChange: (token: string) => void;
	loading: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

function StartNodeDialog({
	nodeName,
	token,
	onTokenChange,
	loading,
	onConfirm,
	onCancel,
}: StartNodeDialogProps) {
	const titleId = `start-dialog-title-${nodeName.replace(/\s+/g, "-")}`;

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape" && !loading) {
			onCancel();
		} else if (e.key === "Enter" && token.trim() && !loading) {
			onConfirm();
		}
	};

	const handleBackdropClick = () => {
		if (!loading) {
			onCancel();
		}
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-th-bg-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onKeyDown={handleKeyDown}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop */}
			<div className="absolute inset-0" onClick={handleBackdropClick} />
			<div className="relative mx-4 w-full max-w-sm rounded-lg bg-th-bg-secondary p-4 shadow-xl">
				<h2
					id={titleId}
					className="text-lg font-bold text-th-text-primary"
				>
					Start "{nodeName}"
				</h2>
				<p className="mt-2 text-sm text-th-text-muted">
					Enter authentication token to start this node.
				</p>

				<div className="mt-4">
					<label
						htmlFor="auth-token"
						className="block text-sm font-medium text-th-text-secondary"
					>
						Auth Token
					</label>
					<input
						id="auth-token"
						type="password"
						value={token}
						onChange={(e) => onTokenChange(e.target.value)}
						onKeyDown={handleKeyDown}
						className="mt-1 w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-th-text-primary placeholder-th-text-muted focus:border-th-accent focus:outline-none focus:ring-1 focus:ring-th-accent"
						placeholder="Enter token..."
						autoFocus
					/>
				</div>

				<div className="mt-4 flex justify-end gap-3">
					<button
						type="button"
						onClick={onCancel}
						disabled={loading}
						className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-text-primary transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={loading || !token.trim()}
						className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm text-white transition-colors hover:bg-green-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:opacity-50"
					>
						{loading && <Spinner size="h-4 w-4" />}
						Start
					</button>
				</div>
			</div>
		</div>
	);
}
