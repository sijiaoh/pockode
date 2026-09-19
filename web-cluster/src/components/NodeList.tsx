import { Spinner } from "@pockode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	getSessionNodePassword,
	rememberSessionNodePassword,
} from "../lib/nodePassword";
import { useWSStore } from "../lib/wsStore";
import type { NodeStatus, NodeWithStatus } from "../types/node";
import { PRIMARY_BUTTON } from "./buttons";
import { NodeCard } from "./NodeCard";
import { NodeForm } from "./NodeForm";
import { ReconnectBanner } from "./ReconnectBanner";

/** Exported so the polling tests advance by the interval rather than by a
 * number that has to be kept in step with this one. */
export const POLL_INTERVAL_MS = 5000;

/**
 * The list is sections, not a filter.
 *
 * A filter hides nodes behind a control and leaves a dead end whenever it
 * matches nothing; a section is always complete and always scannable. The order
 * is what the user should deal with first, which is also why the counts live on
 * the headers — the summary chips they replace announced a stale node and then
 * left it to be hunted for in a flat list.
 */
const SECTIONS: { status: NodeStatus; title: string; dot: string }[] = [
	{ status: "stale", title: "Needs attention", dot: "bg-th-warning" },
	{ status: "running", title: "Running", dot: "bg-th-success" },
	{ status: "stopped", title: "Stopped", dot: "bg-th-text-muted" },
];

/**
 * What a failed clean-up says, named once because two call sites raise it: a
 * card's own Clean up and the section header's Clean up all. Two spellings of
 * one failure is the kind of drift the user sees and nothing else does.
 */
const CLEANUP_FAILED = "Could not clean up this node";

function getErrorMessage(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

function nodeActionError(failure: string, err: unknown) {
	return `${failure}: ${getErrorMessage(err, "Unknown error")}`;
}

export function NodeList() {
	const { status, actions, version } = useWSStore();
	const [nodes, setNodes] = useState<NodeWithStatus[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	// Keyed by node: an error about one node belongs in that node's card, not at
	// the top of a list the user may have scrolled away from. Nothing here
	// expires on a timer — this is the one notice class reporting something the
	// user has to act on, so it stays until they dismiss it or until the next
	// action on the same node succeeds.
	const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
	// Mirrored from the module so the cards re-render the moment a password is
	// remembered. The module, not this state, is what survives the list
	// unmounting on a dropped connection.
	const [savedPassword, setSavedPassword] = useState(getSessionNodePassword);
	const [formOpen, setFormOpen] = useState(false);
	const [editingNode, setEditingNode] = useState<NodeWithStatus | null>(null);
	const [cleaningAll, setCleaningAll] = useState(false);
	const [hidden, setHidden] = useState(() => document.hidden);
	const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

	// Nobody is reading a background tab, and this poll asks the host to stat
	// every registered project directory. Left running, a phone with the panel
	// open in a tab it has forgotten about does that every five seconds for as
	// long as the tab lives. Coming back is where the catch-up fetch belongs:
	// the list on screen is as old as the time away.
	useEffect(() => {
		const onVisibilityChange = () => {
			setHidden(document.hidden);
			if (!document.hidden) fetchNodes();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [fetchNodes]);

	useEffect(() => {
		if (status !== "connected" || loading || hidden) return;

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
	}, [status, loading, hidden, fetchNodes]);

	const setNodeError = useCallback((id: string, message: string) => {
		setNodeErrors((prev) => ({ ...prev, [id]: message }));
	}, []);

	const clearNodeError = useCallback((id: string) => {
		setNodeErrors((prev) => {
			if (!(id in prev)) return prev;
			const { [id]: _, ...rest } = prev;
			return rest;
		});
	}, []);

	const handleAdd = () => {
		setEditingNode(null);
		setFormOpen(true);
	};

	const handleEdit = (node: NodeWithStatus) => {
		setEditingNode(node);
		setFormOpen(true);
	};

	const handleDelete = async (
		id: string,
		options?: { stopFirst?: boolean },
	) => {
		try {
			// The backend's delete does not stop the server; the card offers to do
			// it first so a running node is not left as an unreachable orphan.
			if (options?.stopFirst) {
				await actions.stopNode({ id });
			}
			await actions.deleteNode(id);
			setNodes((prev) => prev.filter((n) => n.id !== id));
			clearNodeError(id);
		} catch (err) {
			// Refreshed for the same reason the other actions are: "Stop and delete"
			// can get past its stop and fail on the delete, leaving a card that
			// still says Running — and offers an Open leading to a server that was
			// just stopped — above an error about deleting.
			await fetchNodes();
			setNodeError(id, getErrorMessage(err, "Failed to delete node"));
		}
	};

	const handleSubmit = async (
		path: string,
		name?: string,
		createMissingDir?: boolean,
	) => {
		if (editingNode) {
			await actions.updateNode({
				id: editingNode.id,
				path,
				name,
				create_missing_dir: createMissingDir,
			});
		} else {
			await actions.createNode({
				path,
				name,
				create_missing_dir: createMissingDir,
			});
		}
		await fetchNodes();
	};

	// Start, Stop and Clean up are one shape: run it, refresh, and put whatever
	// went wrong on that node's card. The refresh happens on the failure path
	// too — a failed action may still have changed the node (a stop that cannot
	// find its process has already removed the leftover; a refused cleanup means
	// the card calling itself stale is wrong), and the card is where the user is
	// looking.
	const runNodeAction = useCallback(
		async (id: string, failure: string, action: () => Promise<unknown>) => {
			try {
				await action();
				await fetchNodes();
				clearNodeError(id);
				return true;
			} catch (err) {
				await fetchNodes();
				setNodeError(id, nodeActionError(failure, err));
				return false;
			}
		},
		[fetchNodes, clearNodeError, setNodeError],
	);

	// A password is only worth remembering once it has actually started
	// something: remembering a rejected one would turn every later Start into a
	// silent one-tap failure, which is worse than being asked.
	const handleStart = async (id: string, password: string) => {
		const started = await runNodeAction(id, "Could not start this node", () =>
			actions.startNode({ id, password }),
		);
		if (started) {
			rememberSessionNodePassword(password);
			setSavedPassword(password);
		}
		return started;
	};

	// The outcome is dropped rather than returned: only Start has something to
	// do with it, and a card that cannot tell stop from cleanup success is a
	// card that never had to.
	const handleStop = async (id: string) => {
		await runNodeAction(id, "Could not stop this node", () =>
			actions.stopNode({ id }),
		);
	};

	const handleCleanup = async (id: string) => {
		await runNodeAction(id, CLEANUP_FAILED, () => actions.cleanupNode({ id }));
	};

	// Leftovers arrive in batches — one reboot orphans every node on the machine
	// — which is what makes this the one batch action worth having. Run as a
	// single round with one refresh at the end rather than as N `runNodeAction`
	// calls, which would re-list the whole cluster once per node; a node that
	// refuses still gets its own error on its own card.
	const handleCleanupAll = async (ids: string[]) => {
		setCleaningAll(true);
		try {
			const results = await Promise.allSettled(
				ids.map((id) => actions.cleanupNode({ id })),
			);
			for (const [index, result] of results.entries()) {
				const id = ids[index];
				if (result.status === "fulfilled") {
					clearNodeError(id);
				} else {
					setNodeError(id, nodeActionError(CLEANUP_FAILED, result.reason));
				}
			}
			await fetchNodes();
		} finally {
			setCleaningAll(false);
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
				<button type="button" onClick={fetchNodes} className={PRIMARY_BUTTON}>
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
					{/* Always rendered, including the reconnect wording the banner
					    below also carries. Showing it only while connected would make
					    the header's own height depend on the connection, and it would
					    move at the very moment the banner is already moving the list
					    under it. */}
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
					className={`${PRIMARY_BUTTON} min-w-[44px]`}
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

			<ReconnectBanner />

			<div className="flex-1 overflow-y-auto p-4">
				{/* Cards are read one at a time, so they stop widening long before the
				    window does; past the expanded tier the spare width becomes a
				    second column instead. */}
				<div className="mx-auto max-w-3xl">
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
								className={`${PRIMARY_BUTTON} mt-6`}
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
						SECTIONS.map(({ status: sectionStatus, title, dot }) => {
							const sectionNodes = nodes
								.filter((node) => node.status.status === sectionStatus)
								.sort((a, b) => a.name.localeCompare(b.name));
							// An empty section is not a fact worth a row of its own.
							if (sectionNodes.length === 0) return null;

							return (
								<section key={sectionStatus} className="mb-2">
									<div className="sticky top-0 z-10 -mx-4 flex items-center gap-2 bg-th-bg-primary px-4 py-2">
										<span
											className={`size-2 shrink-0 rounded-full ${dot}`}
											aria-hidden="true"
										/>
										<h2 className="text-sm font-medium text-th-text-primary">
											{title}
										</h2>
										<span className="text-sm text-th-text-muted">
											{sectionNodes.length}
										</span>
										{sectionStatus === "stale" && sectionNodes.length > 1 && (
											<button
												type="button"
												onClick={() =>
													handleCleanupAll(sectionNodes.map((node) => node.id))
												}
												disabled={cleaningAll}
												className="touch-target ml-auto text-sm text-th-accent underline underline-offset-2 disabled:opacity-50 hover:opacity-80"
											>
												{cleaningAll ? "Cleaning up..." : "Clean up all"}
											</button>
										)}
									</div>

									<div className="grid gap-3 lg:grid-cols-2">
										{sectionNodes.map((node) => (
											<NodeCard
												key={node.id}
												node={node}
												error={nodeErrors[node.id]}
												savedPassword={savedPassword}
												onDismissError={clearNodeError}
												onEdit={handleEdit}
												onDelete={handleDelete}
												onStart={handleStart}
												onStop={handleStop}
												onCleanup={handleCleanup}
											/>
										))}
									</div>
								</section>
							);
						})
					)}

					{/* After the last card rather than pinned to the corner, where it
					    floated over whatever scrolled underneath it. */}
					{version && (
						<p className="mt-6 text-center text-xs text-th-text-muted">
							Pockode cluster v{version}
						</p>
					)}
				</div>
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
