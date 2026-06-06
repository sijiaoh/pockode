export interface Node {
	id: string;
	path: string;
	name: string;
	created_at: string;
	updated_at: string;
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
