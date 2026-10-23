/** Chromium's batch size for `readEntries`. */
const BATCH = 100;

export type FolderNode = File | Error | { [name: string]: FolderNode };

/**
 * A `FileSystemDirectoryEntry` over a plain tree, which jsdom has none of: a
 * `File` is a file, an `Error` is a file that cannot be read, an object is a
 * directory. Entries come back in batches of 100 as Chromium hands them over,
 * so a reader that asks once sees only the first batch.
 */
export function folderEntry(
	name: string,
	children: { [name: string]: FolderNode },
): FileSystemDirectoryEntry {
	return {
		name,
		isDirectory: true,
		isFile: false,
		createReader() {
			const all = Object.entries(children).map(([childName, node]) =>
				node instanceof File || node instanceof Error
					? {
							name: childName,
							isDirectory: false,
							isFile: true,
							file: (
								resolve: (file: File) => void,
								reject: (error: Error) => void,
							) => (node instanceof Error ? reject(node) : resolve(node)),
						}
					: folderEntry(childName, node),
			);
			let offset = 0;
			return {
				readEntries(resolve: (entries: unknown[]) => void) {
					const batch = all.slice(offset, offset + BATCH);
					offset += batch.length;
					resolve(batch);
				},
			};
		},
	} as unknown as FileSystemDirectoryEntry;
}
