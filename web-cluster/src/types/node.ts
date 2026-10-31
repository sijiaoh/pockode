export interface Node {
	id: string;
	path: string;
	name: string;
	created_at: string;
	/** Record last modified. Not the sort key — see `last_used_at`. */
	updated_at: string;
	/** Last edited or started, which is the order the list is read in. */
	last_used_at: string;
}

/**
 * `restarting` is the cluster's own state: from an accepted `node.restart`
 * until the node's successor publishes its `server.json`, or a minute passes
 * (docs/restart-ui.md, "While a node restarts").
 */
export type NodeStatus = "running" | "stopped" | "stale" | "restarting";

export interface NodeStatusInfo {
	id: string;
	status: NodeStatus;
	port?: number;
	started_at?: string;
	local_url?: string;
	remote_url?: string;
	/** The running version, only while running. Absent: a node started by a
	 * build older than the field — and than node restarts. */
	version?: string;
	/** RFC3339; while restarting, and while `restart_error` is set. */
	restart_requested_at?: string;
	/** Why the last restart did not come back, in English, shown as it is. */
	restart_error?: string;
}

export interface NodeWithStatus extends Node {
	status: NodeStatusInfo;
}

export interface NodeCreateParams {
	path: string;
	name?: string;
	create_missing_dir?: boolean;
}

export interface NodeUpdateParams {
	id: string;
	path?: string;
	name?: string;
	create_missing_dir?: boolean;
}

export interface NodeStartParams {
	id: string;
	password: string;
}

export interface NodeStopParams {
	id: string;
}

export interface NodeCleanupParams {
	id: string;
}

export interface NodeRestartParams {
	id: string;
}
