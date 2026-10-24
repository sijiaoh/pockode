import {
	JSONRPCErrorCode,
	JSONRPCErrorException,
	type JSONRPCRequester,
} from "json-rpc-2.0";
import type { Entry, EntryType, FileContent } from "../../types/contents";
import type { FileSearchMode, FileSearchResult } from "../../types/search";

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

/** Kept apart from `file.write`, which upserts; creation fails on a taken path. */
interface FileCreateParams {
	path: string;
	type: EntryType;
}

interface FileDeleteParams {
	path: string;
}

/**
 * A new name, not a new path: renaming never leaves the entry's own directory.
 * Allowing a path here would fold moving — and creating the directories a move
 * implies — into a text field the user reads as "what should this be called".
 */
interface FileRenameParams {
	path: string;
	new_name: string;
}

/**
 * Rename's other half: the entry keeps its name and changes directory.
 * `destination` is an existing directory — "" for the work directory — and is
 * never created on the way.
 */
interface FileMoveParams {
	path: string;
	destination: string;
}

interface FileMoveResult {
	path: string;
}

export interface FileSearchParams {
	/** Literal substring, not a pattern. */
	query: string;
	/** Defaults to "name" on the server. */
	mode?: FileSearchMode;
	/** Limits the search to a subdirectory of the work directory. */
	path?: string;
	/** Defaults to true on the server when omitted. */
	respect_gitignore?: boolean;
	case_sensitive?: boolean;
	/** Caps the number of returned files; server default 100, hard cap 500. */
	max_results?: number;
}

/**
 * Whether the server turned a name down because something already has it.
 *
 * `file.create` and `file.rename` both answer a taken path with "<path> already
 * exists", and both naming sheets treat that one refusal differently from every
 * other failure: it is answerable by typing another name, so the sheet stays up
 * holding it. One predicate rather than the phrase spelled out at each call
 * site, or the two entry points drift apart the day the wording changes.
 *
 * The whole message has to be matched because both refusals arrive as
 * `InvalidParams`, the same code as "not found" and "invalid path" — there is
 * nothing else to tell them apart by. A suffix rather than a substring, so a
 * path that merely contains the phrase ("not found: docs/already exists.md")
 * is not mistaken for one.
 */
export function isAlreadyExistsError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.endsWith(" already exists");
}

/** Where: server/rpc/types.go's FileMoveReason* constants. */
const MOVE_REFUSED_REASONS = [
	"invalid_path",
	"not_found",
	"destination_not_found",
	"not_a_directory",
	"into_itself",
	"exists",
] as const;

export type FileMoveRefusedReason = (typeof MOVE_REFUSED_REASONS)[number];

/**
 * Why the server refused a `file.move`, or null if the failure is anything
 * else. Recognised by the code and `data.reason`, never the message, which is prose the
 * server may reword. "exists" is the same refusal `isAlreadyExistsError`
 * recognises, and its message is the same sentence.
 */
export function fileMoveRefusedReason(
	error: unknown,
): FileMoveRefusedReason | null {
	if (
		!(error instanceof JSONRPCErrorException) ||
		error.code !== JSONRPCErrorCode.InvalidParams
	) {
		return null;
	}
	const reason = (error.data as { reason?: unknown } | undefined)?.reason;
	return MOVE_REFUSED_REASONS.find((r) => r === reason) ?? null;
}

export interface FileActions {
	getFile: (path?: string) => Promise<FileGetResult>;
	writeFile: (path: string, content: string) => Promise<void>;
	/** Creates an empty file or directory; rejects if the path is taken. */
	createFile: (path: string, type: EntryType) => Promise<void>;
	deleteFile: (path: string) => Promise<void>;
	/** Renames within the entry's own directory; rejects if the name is taken. */
	renameFile: (path: string, newName: string) => Promise<void>;
	/**
	 * Moves into an existing directory, keeping the name, and resolves to the
	 * entry's new path. Moving into the directory it is already in resolves
	 * to its path unchanged; see `fileMoveRefusedReason` for the refusals.
	 */
	moveFile: (path: string, destination: string) => Promise<string>;
	searchFiles: (params: FileSearchParams) => Promise<FileSearchResult>;
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
		createFile: async (path: string, type: EntryType): Promise<void> => {
			await requireClient().request("file.create", {
				path,
				type,
			} as FileCreateParams);
		},
		deleteFile: async (path: string): Promise<void> => {
			await requireClient().request("file.delete", {
				path,
			} as FileDeleteParams);
		},
		renameFile: async (path: string, newName: string): Promise<void> => {
			await requireClient().request("file.rename", {
				path,
				new_name: newName,
			} as FileRenameParams);
		},
		moveFile: async (path: string, destination: string): Promise<string> => {
			const result: FileMoveResult = await requireClient().request(
				"file.move",
				{ path, destination } as FileMoveParams,
			);
			return result.path;
		},
		searchFiles: async (
			params: FileSearchParams,
		): Promise<FileSearchResult> => {
			return requireClient().request("file.search", params);
		},
	};
}
