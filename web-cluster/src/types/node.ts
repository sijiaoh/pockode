export interface Node {
	id: string;
	path: string;
	name: string;
	created_at: string;
	updated_at: string;
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
}

export interface NodeUpdateParams {
	id: string;
	path?: string;
	name?: string;
}

export interface NodeStartParams {
	id: string;
	token: string;
}

export interface NodeStopParams {
	id: string;
}
