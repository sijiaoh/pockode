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

export type NodeStatus = "running" | "stopped" | "stale";

export interface NodeStatusInfo {
	id: string;
	status: NodeStatus;
	port?: number;
	started_at?: string;
	local_url?: string;
	remote_url?: string;
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
