/**
 * The name a group summary gives a shell command: `Ran pnpm test`. Shell text
 * is read just far enough to find the command that does the work — through the
 * `cd`, the variables, the loop headers and the `echo` banners an agent wraps
 * around it — and, where it cannot tell, it says nothing rather than name a
 * keyword or a variable. The row under the summary has the whole command.
 */

interface Word {
	kind: "word";
	/** The word with its quotes and escapes taken off. */
	value: string;
	/** No quoting, escaping or expansion anywhere in it: it says what it is. */
	plain: boolean;
	/**
	 * `value` is the word the shell would pass on: nothing in it is expanded,
	 * and no double-quoted part holds an escape left in place.
	 */
	literal: boolean;
	/** Where in the text the word stops. */
	end: number;
}

interface Operator {
	kind: "op";
	/** `&&`, `|`, `;`, `(`… — a newline reads as `;`. */
	value: string;
}

type Token = Word | Operator;

const OPERATORS = ["&&", "||", "|&", ";;", "|", ";", "&", "(", ")"];

/** What the sticky `pattern` matches at `at`, or "" when it does not. */
function matchAt(pattern: RegExp, text: string, at: number): string {
	pattern.lastIndex = at;
	return pattern.exec(text)?.[0] ?? "";
}

const PARAMETER = /\w+|[?#$!@*0-9-]/y;
const REDIRECTION = /&>>?|<<<|<<-?|<>|>>|>\||[<>]&?/y;
const DUPLICATED_FD = /\d+|-/y;
const HEREDOC_DELIMITER = /(['"]?)\\?([\w.-]+)\1/y;

/** Where a `$(`, `${` or backquote that opens at `start` closes. */
function expansionEnd(text: string, start: number): number {
	const open = text[start];
	if (open === "`") {
		const end = text.indexOf("`", start + 1);
		return end === -1 ? text.length : end + 1;
	}
	const [inc, dec] = open === "{" ? ["{", "}"] : ["(", ")"];
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") i++;
		else if (c === "'") {
			const end = text.indexOf("'", i + 1);
			i = end === -1 ? text.length : end;
		} else if (c === inc) depth++;
		else if (c === dec && --depth === 0) return i + 1;
	}
	return text.length;
}

/**
 * Splits shell text into words and operators the way the shell would for
 * what a command head needs: quotes, escapes and expansions stay inside their
 * word, comments and here-doc bodies are dropped, and a redirection takes its
 * target with it.
 */
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	const heredocs: string[] = [];
	let value = "";
	let plain = true;
	let literal = true;
	let started = false;
	let dropNextWord = false;

	const endWord = () => {
		if (!started) return;
		// A glob or a brace expansion stands for words not written here.
		if (plain && /[*?[\]{}]/.test(value) && !/^(\[\[?|\]\]?|[{}])$/.test(value))
			plain = false;
		if (dropNextWord) dropNextWord = false;
		else tokens.push({ kind: "word", value, plain, literal, end: i });
		value = "";
		plain = true;
		literal = true;
		started = false;
	};

	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\" && text[i + 1] === "\n") {
			endWord();
			i += 2;
		} else if (c === "\n") {
			endWord();
			tokens.push({ kind: "op", value: ";" });
			i++;
			// A here-doc's body is the input of the command above it, not commands.
			for (const delimiter of heredocs.splice(0)) {
				while (i < text.length) {
					const lineEnd = text.indexOf("\n", i);
					const end = lineEnd === -1 ? text.length : lineEnd;
					const line = text.slice(i, end);
					i = end + 1;
					if (line.trim() === delimiter) break;
				}
			}
		} else if (c === " " || c === "\t" || c === "\r") {
			endWord();
			i++;
		} else if (c === "#" && !started) {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "'") {
			const end = text.indexOf("'", i + 1);
			const close = end === -1 ? text.length : end;
			value += text.slice(i + 1, close);
			plain = false;
			started = true;
			i = close + 1;
		} else if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') {
				if (text[j] === "\\") j++;
				else if (text[j] === "$" && "({".includes(text[j + 1] ?? "")) {
					j = expansionEnd(text, j + 1) - 1;
				} else if (text[j] === "`") j = expansionEnd(text, j) - 1;
				j++;
			}
			const quoted = text.slice(i + 1, j);
			if (/[\\$`]/.test(quoted)) literal = false;
			value += quoted;
			plain = false;
			started = true;
			i = j + 1;
		} else if (c === "\\") {
			value += text[i + 1] ?? "";
			plain = false;
			started = true;
			i += 2;
		} else if (c === "$" || c === "`") {
			const end =
				c === "`"
					? expansionEnd(text, i)
					: "({".includes(text[i + 1] ?? "")
						? expansionEnd(text, i + 1)
						: i + 1 + matchAt(PARAMETER, text, i + 1).length;
			value += text.slice(i, end);
			plain = false;
			literal = false;
			started = true;
			i = end;
		} else if (c === "<" || c === ">" || (c === "&" && text[i + 1] === ">")) {
			// `2>&1`: the digits in front belong to the redirection.
			if (/^\d+$/.test(value) && plain) {
				value = "";
				started = false;
			} else endWord();
			const op = matchAt(REDIRECTION, text, i);
			i += op.length;
			if (op.endsWith("&")) {
				const fd = matchAt(DUPLICATED_FD, text, i);
				if (fd) {
					i += fd.length;
					continue;
				}
			}
			while (text[i] === " " || text[i] === "\t") i++;
			if (op === "<<" || op === "<<-") {
				HEREDOC_DELIMITER.lastIndex = i;
				const delimiter = HEREDOC_DELIMITER.exec(text);
				if (delimiter) {
					heredocs.push(delimiter[2]);
					i += delimiter[0].length;
					continue;
				}
			}
			// `<(sort a)`: a process substitution is the redirection's target.
			if (text[i] === "(" && (op === "<" || op === ">")) {
				i = expansionEnd(text, i);
				continue;
			}
			dropNextWord = true;
		} else {
			// `arr=(a b)`: the parentheses hold the array, not a subshell.
			if (c === "(" && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(value)) {
				const end = expansionEnd(text, i);
				value += text.slice(i, end);
				plain = false;
				literal = false;
				i = end;
				continue;
			}
			const op = OPERATORS.find((o) => text.startsWith(o, i));
			if (op) {
				endWord();
				dropNextWord = false;
				tokens.push({ kind: "op", value: op });
				i += op.length;
			} else {
				value += c;
				started = true;
				i++;
			}
		}
	}
	endWord();
	return tokens;
}

/** The simple commands in order, each as its words. */
function simpleCommands(tokens: Token[]): Word[][] {
	const commands: Word[][] = [[]];
	for (const token of tokens) {
		if (token.kind === "op") commands.push([]);
		else commands[commands.length - 1].push(token);
	}
	return commands.filter((words) => words.length > 0);
}

/** Words that open or close a compound command, ahead of the one inside. */
const KEYWORDS = new Set([
	"!",
	"{",
	"}",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"while",
	"until",
	"do",
	"done",
]);

/** Commands that run the command after their own flags and operands. */
const WRAPPERS = new Set([
	"env",
	"exec",
	"nice",
	"nohup",
	"stdbuf",
	"sudo",
	"time",
	"timeout",
]);

/**
 * Commands an agent runs around the work rather than as it: where it runs,
 * what it is set up with, a banner between outputs, a pause, a test. Passed
 * over when something else follows, and the name only when nothing does.
 */
const SETUP = new Set([
	".",
	":",
	"[",
	"[[",
	"alias",
	"cd",
	"declare",
	"echo",
	"export",
	"false",
	"local",
	"popd",
	"printf",
	"pushd",
	"read",
	"readonly",
	"set",
	"shopt",
	"sleep",
	"source",
	"test",
	"trap",
	"true",
	"typeset",
	"ulimit",
	"umask",
	"unset",
	"wait",
]);

const SHELLS = new Set(["bash", "sh", "zsh"]);

const SHELL_FIRST = new RegExp(`^\\s*(\\S*/)?(${[...SHELLS].join("|")})\\s`);

/** `-c`, `-lc`, `-cl`…: the shell flags that run the next word as a script. */
const RUNS_SCRIPT = /^-\w*c\w*$/;

/**
 * The script inside a CLI's own shell envelope — Codex runs every command as
 * `/bin/zsh -lc '…'` — or the command as it is when it is anything more than
 * exactly that envelope: a script that is read off it word for word or not at
 * all.
 */
export function unwrapShellCommand(command: string): string {
	// Every Bash summary comes through here, a long here-doc included: only a
	// command that opens on a shell is worth tokenizing.
	if (!SHELL_FIRST.test(command)) return command;
	const tokens = tokenize(command);
	if (tokens.length !== 3 || tokens.some((token) => token.kind === "op"))
		return command;
	const [shell, flag, script] = tokens as Word[];
	if (
		shell.plain &&
		SHELLS.has(basename(shell.value)) &&
		// Nothing the tokenizer passes over — a redirection, a comment, an
		// unclosed quote — sits before the shell or after the script.
		command.trimStart().startsWith(shell.value) &&
		script.end === command.trimEnd().length &&
		flag.plain &&
		RUNS_SCRIPT.test(flag.value) &&
		script.literal &&
		script.value.trim()
	)
		return script.value;
	return command;
}

const isAssignment = (word: Word) =>
	/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word.value);

/** A wrapper's flags that take the word after them as their value. */
const WRAPPER_FLAG_VALUES: Record<string, string[]> = {
	env: ["-u", "-C", "-S"],
	sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"],
	timeout: ["-s", "-k"],
	nice: ["-n"],
};

/**
 * Where the command a wrapper runs starts: past its flags, their values, the
 * variables it sets and the duration or niceness it is given.
 */
function wrappedStart(words: Word[], wrapper: number): number {
	const takesValue = WRAPPER_FLAG_VALUES[basename(words[wrapper].value)] ?? [];
	let i = wrapper + 1;
	for (;;) {
		const word = words[i];
		if (!word) return i;
		if (takesValue.includes(word.value)) i += 2;
		else if (
			word.value.startsWith("-") ||
			isAssignment(word) ||
			/^\d+(\.\d+)?[smhd]?$/.test(word.value)
		)
			i++;
		else return i;
	}
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A word that names a place to act on and nothing more: `find .`. */
const isBareScope = (value: string) => /^[./~]+$/.test(value);

/**
 * A command's first few words, before the flags, the quoted or expanded
 * arguments and the redirections: what a reader recognises it by.
 */
function headWords(words: Word[]): string {
	const head = [basename(words[0].value)];
	for (const word of words.slice(1, 3)) {
		if (!word.plain || word.value.startsWith("-") || isBareScope(word.value))
			break;
		head.push(word.value);
	}
	return head.join(" ");
}

export function commandHead(command: string): string | undefined {
	const commands = simpleCommands(tokenize(command));
	// The name a command of nothing but setup goes by: `cd web`, `sleep 5`.
	let setup: string | undefined;
	let onlySetup = true;
	let awaiting: "do" | "]]" | undefined;
	for (const command of commands) {
		let i = 0;
		if (awaiting === "]]") {
			const close = command.findIndex((word) => word.value === "]]");
			if (close === -1) continue;
			awaiting = undefined;
			i = close + 1;
		}
		for (;;) {
			const word = command[i];
			if (!word) break;
			if (awaiting === "do" && !(word.plain && word.value === "do")) {
				i = command.length;
			} else if (word.plain && KEYWORDS.has(word.value)) {
				// A loop or a conditional of nothing but setup is not named by it.
				onlySetup = false;
				if (word.value === "do") awaiting = undefined;
				i++;
			} else if (isAssignment(word)) {
				i++;
			} else if (word.plain && WRAPPERS.has(basename(word.value))) {
				const start = wrappedStart(command, i);
				// `env | grep X`: a wrapper with nothing to run is the command.
				if (!command[start]) break;
				i = start;
			} else break;
		}
		const first = command[i];
		if (!first) continue;
		// A name that is a variable or an expansion is not one a reader knows.
		if (!first.plain || first.value.startsWith("-")) return undefined;
		if (first.value === "for" || first.value === "select") {
			awaiting = "do";
			onlySetup = false;
			continue;
		}
		if (first.value === "case" || first.value === "function") return undefined;
		const words = command.slice(i);
		const name = basename(first.value);
		if (SHELLS.has(name)) {
			// Codex runs every command as `bash -lc '…'`.
			let j = 1;
			while (
				words[j]?.value.startsWith("-") &&
				!RUNS_SCRIPT.test(words[j].value)
			)
				j++;
			if (RUNS_SCRIPT.test(words[j]?.value ?? "")) {
				const script = words[j + 1]?.value;
				return script === undefined ? undefined : commandHead(script);
			}
		}
		if (SETUP.has(name)) {
			setup ??= headWords(words);
			if (name === "[[" && !words.some((word) => word.value === "]]"))
				awaiting = "]]";
			continue;
		}
		return headWords(words);
	}
	return onlySetup ? setup : undefined;
}
