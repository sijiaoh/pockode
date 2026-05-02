import type { JSONRPCRequester } from "json-rpc-2.0";
import type { Entry, FileContent } from "../../types/contents";

interface FileGetParams {
	path: string;
}

interface FileGetResult {
	type: "directory" | "file";
	entries?: Entry[];
	file?: FileContent;
}

interface FileWriteParams {
	path: string;
	content: string;
}

interface FileDeleteParams {
	path: string;
}

export interface FileActions {
	getFile: (path?: string) => Promise<FileGetResult>;
	writeFile: (path: string, content: string) => Promise<void>;
	deleteFile: (path: string) => Promise<void>;
}

export function createFileActions(
	getClient: () => JSONRPCRequester<void> | null,
): FileActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		getFile: async (path = ""): Promise<FileGetResult> => {
			return requireClient().request("file.get", {
				path,
			} as FileGetParams);
		},
		writeFile: async (path: string, content: string): Promise<void> => {
			await requireClient().request("file.write", {
				path,
				content,
			} as FileWriteParams);
		},
		deleteFile: async (path: string): Promise<void> => {
			await requireClient().request("file.delete", {
				path,
			} as FileDeleteParams);
		},
	};
}
