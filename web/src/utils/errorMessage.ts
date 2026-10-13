/** What to show for a caught value: its message when it is an Error. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A caught value as an Error, for state that holds one. */
export function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
