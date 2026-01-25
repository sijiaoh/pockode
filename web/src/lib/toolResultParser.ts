export interface ParsedLine {
	lineNumber: number;
	content: string;
}

/**
 * Parse Read tool result (line number→content format).
 * Claude Code outputs: "     1→import { foo } from 'bar';"
 */
export function parseReadResult(result: string): ParsedLine[] {
	return result
		.split("\n")
		.map((line) => {
			const match = line.match(/^\s*(\d+)→(.*)$/);
			return match
				? { lineNumber: parseInt(match[1], 10), content: match[2] }
				: null;
		})
		.filter((x): x is ParsedLine => x !== null);
}
