/**
 * Last segment of a filesystem path, accepting either separator.
 *
 * A node path is typed by the user and names a directory on the node's own
 * machine, so it is in that machine's native form — backslash-separated on
 * Windows. This mirrors what the server derives a node name with
 * (`filepath.Base`), so the placeholder matches the name actually assigned.
 */
export function baseName(path: string): string {
	return path.split(/[/\\]/).filter(Boolean).pop() ?? "";
}
