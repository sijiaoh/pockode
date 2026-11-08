import { useEffect, useState } from "react";
import type { NodeStatus } from "../types/node";
import { StartNodeSheet } from "./StartNodeSheet";

interface Props {
	nodeId: string;
	nodeName: string;
	/** As the list last saw it; undefined once the node is gone from it. */
	status: NodeStatus | undefined;
	/** The node's card error: what the failed stop or start left there. */
	error?: string;
	/** Resolve to whether it worked; a failure is already on the card. */
	onStop: (id: string) => Promise<boolean>;
	onStart: (id: string, password: string) => Promise<boolean>;
	onClose: () => void;
}

/**
 * An older node's Restart: `node.stop`, and only once that succeeded,
 * `node.start` with the password typed here — never the restart request,
 * which unix would deliver as a kill (docs/restart-ui.md, "Older nodes: stop
 * and start, once").
 *
 * Held by the list rather than the card: the stop moves the card to the
 * Stopped section, which mounts it afresh, and this sheet has to outlive that
 * to run the start — and to become the Start sheet if the start fails.
 */
export function RestartOlderNodeSheet({
	nodeId,
	nodeName,
	status,
	error,
	onStop,
	onStart,
	onClose,
}: Props) {
	const [password, setPassword] = useState("");
	const [progress, setProgress] = useState<"stopping" | "starting" | null>(
		null,
	);
	// Once the stop has succeeded and the start has not, the node is a stopped
	// one and this is exactly its Start sheet.
	const [stage, setStage] = useState<"stopAndStart" | "start">("stopAndStart");
	const [failed, setFailed] = useState(false);

	// A node that stopped by itself — from another device, or a failed stop
	// that found nothing to stop — has nothing left to stop: a stop now would
	// only fail again, and the start would never be tried.
	useEffect(() => {
		if (progress === null && (status === "stopped" || status === "stale")) {
			setStage("start");
		}
	}, [progress, status]);

	const confirm = async () => {
		const trimmed = password.trim();
		if (!trimmed) return;
		setFailed(false);
		try {
			if (stage === "stopAndStart") {
				setProgress("stopping");
				if (!(await onStop(nodeId))) {
					setFailed(true);
					return;
				}
			}
			setProgress("starting");
			if (await onStart(nodeId, trimmed)) {
				onClose();
			} else {
				setStage("start");
				setFailed(true);
			}
		} finally {
			setProgress(null);
		}
	};

	return (
		<StartNodeSheet
			nodeName={nodeName}
			variant={stage}
			error={failed ? error : undefined}
			password={password}
			progress={progress}
			onPasswordChange={setPassword}
			onConfirm={() => void confirm()}
			onCancel={() => {
				if (progress === null) onClose();
			}}
		/>
	);
}
