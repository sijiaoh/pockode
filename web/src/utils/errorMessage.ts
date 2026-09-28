/** What to show for a caught value: its message when it is an Error. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
