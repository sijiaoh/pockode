import { Blob as NodeBlob } from "node:buffer";

/**
 * jsdom's Blob predates the spec: it has no `text()`, `arrayBuffer()` or
 * `stream()`, and it concatenates only its own Blobs — any other Blob passed to
 * its constructor is stringified into `[object Blob]`.
 *
 * That matters because two Blob implementations meet in a test: the one
 * `globalThis.Blob` names, and the one `Response.blob()` returns. Node 24
 * builds the latter with the former, Node 22 with its own, so leaving jsdom's
 * in place makes the pair agree on one version of Node and silently corrupt
 * data on the other. Node's Blob is spec-compliant and is what undici reaches
 * for either way, so installing it globally leaves one Blob everywhere — the
 * situation a browser is in.
 *
 * Lives outside `src` because it is the one piece of test setup that needs
 * Node types, which the app project deliberately does not have.
 */
globalThis.Blob = NodeBlob;
