import type { OmitReason } from "./contents";

/**
 * One file-like piece of an agent's output — the image a tool returned, the PDF
 * a read delivered. Mirrors `agent.FileBlock` on the server.
 *
 * `attachment_id` is the one route to the bytes: an agent that delivers content
 * inline has it stored there, and so does one that only names a file, which the
 * server reads when the event arrives. `path` says which file was looked at and
 * is never fetched by — it is what offers the way over to the Files tab — so a
 * block may carry both, as Codex's do. `omitted` says why a block has neither.
 */
export interface FileBlock {
	/** Absent when the agent named no file, which is usual for an inline image. */
	name?: string;
	/** What the agent called the content. Empty when it said nothing. */
	mime: string;
	size?: number;
	/**
	 * The delivered bytes' dimensions, absent when they could not be read. They
	 * are what lets the strip hold an image's space before it arrives, which is
	 * what keeps loading a history page from moving the text under the reader.
	 */
	width?: number;
	height?: number;
	attachment_id?: string;
	/** Absolute, on the machine the agent runs on; may be outside the work dir. */
	path?: string;
	omitted?: OmitReason;
	/** The ceiling that kept the content out; only with `too_large`. */
	limit?: number;
}

/**
 * One piece of a tool result, in the order the agent produced it. Mirrors
 * `agent.ContentBlock`, narrowed to a union: on the wire the three kinds share
 * one object with optional fields, and a block missing the field its type calls
 * for is dropped at the boundary rather than carried as a half-block.
 */
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "file"; file: FileBlock }
	| { type: "tool_reference"; toolName: string };

/**
 * Where an attachment's bytes come from: the content the server stored, or —
 * when it could keep none but the block names a file in the work directory —
 * that file, read the way the Files tab reads it. Both answer with a
 * `FileContent`, so only the fetch differs; see `attachmentSource`, which is
 * what decides between them.
 */
export type AttachmentSource =
	| { kind: "attachment"; sessionId: string; id: string }
	| { kind: "file"; path: string };
