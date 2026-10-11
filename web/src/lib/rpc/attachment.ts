import type { JSONRPCRequester } from "json-rpc-2.0";
import type { FileContent } from "../../types/contents";

interface AttachmentGetParams {
	session_id: string;
	id: string;
}

interface AttachmentGetResult {
	file: FileContent;
}

export interface AttachmentActions {
	/**
	 * Describes content a chat event references by id, carrying it inline only
	 * when it is text; a raster image's bytes are read over HTTP afterwards
	 * (`fetchImageBlob`). The reply has the same shape as `file.get`'s, so one
	 * code path renders both.
	 */
	getAttachment: (sessionId: string, id: string) => Promise<FileContent>;
}

export function createAttachmentActions(
	getClient: () => JSONRPCRequester<void> | null,
): AttachmentActions {
	return {
		getAttachment: async (
			sessionId: string,
			id: string,
		): Promise<FileContent> => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("attachment.get", {
				session_id: sessionId,
				id,
			} as AttachmentGetParams)) as AttachmentGetResult;
			return result.file;
		},
	};
}
