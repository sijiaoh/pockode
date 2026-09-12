const UNITS = ["B", "KB", "MB", "GB", "TB"];

// One decimal only below 100, where it still carries information: "1.5 MB" says
// something "2 MB" does not, while "248.3 KB" says nothing "248 KB" doesn't.
function round(value: number, unit: number): number {
	return unit === 0 || value >= 100
		? Math.round(value)
		: Math.round(value * 10) / 10;
}

/**
 * Human-readable byte count, e.g. `1536` -> `1.5 KB`.
 *
 * Binary steps (1024) rather than decimal ones: the sizes shown here are
 * compared against limits that are themselves powers of two, and a 2 MiB cap
 * rendered as "2.1 MB" would read as a contradiction.
 */
export function formatBytes(bytes: number): string {
	let value = Math.max(0, bytes);
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}

	let rounded = round(value, unit);
	// Rounding can land on the next unit on its own: a byte under 1 MiB divides
	// to 1023.999 KB, which stays in the loop's unit but prints as "1024 KB".
	if (rounded >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
		rounded = round(value, unit);
	}

	return `${rounded} ${UNITS[unit]}`;
}
