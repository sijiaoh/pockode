import type * as Wire from "./wire.generated";

/**
 * One file-like piece of an agent's output — the image a tool returned, the PDF
 * a read delivered — exactly as the server sends it (`agent.FileBlock`).
 */
export type FileBlock = Wire.FileBlock;

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
