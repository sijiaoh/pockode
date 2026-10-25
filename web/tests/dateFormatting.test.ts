import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { repoPath, sourceFiles } from "./sourceScan";

// Every displayed date and time goes through one module, so a time reads the
// same on every surface and in every locale. A component that formats an
// instant itself — `toLocaleTimeString()`, its own `Intl.DateTimeFormat`, a
// `getHours()` padded by hand — brings back the browser-locale `02:02 PM` next
// to everybody else's `14:02`, and nothing renders wrong enough to notice.
//
// A typed scan rather than a lint rule or a regex: `toLocaleString` and
// `toString` are as much `Number`'s as `Date`'s, and `utils/tokens.ts` rightly
// formats numbers with them. Only the checker can tell the receivers apart, so
// the rule reads the receiver's type instead of keeping an allowlist of
// number-formatting files.
//
// What it cannot see: text cut out of `toISOString()` looks like serialisation,
// and an `any` is nobody's `Date`.
//
// `web/src` only: the module is web's, and nothing in web-cluster or
// packages/shared shows a time. A frontend there that starts to would need its
// own module before a rule could point anywhere.

const MODULE = "web/src/utils/dateTime.ts";
const REMEDY = `go through ${MODULE} (relative ages and waits: web/src/utils/relativeTime.ts)`;

// Where raw date APIs are the job: the module itself, and the functions in the
// zone helpers that read an instant on a zone's wall clock or check a calendar
// date — what the module is built on, producing no date or time text. Named by
// function, so the rest of that file (which does write zone labels) is held to
// the rule like anywhere else.
const ENTITLED: Record<string, "whole file" | string[]> = {
	[MODULE]: "whole file",
	"web/src/lib/scheduleZone.ts": [
		"zoneOffsetSeconds",
		"wallClock",
		"parseWallClock",
	],
};

// Date methods that produce text, and the fields a hand-rolled clock is built
// from. A field read outside the module also skips its zone handling: the
// module reads wall-clock fields through `wallClock()`, in a schedule's zone
// where it has one. `getTime`, `toISOString` and `toJSON` are serialisation
// and arithmetic, and stay free.
const DATE_METHODS = new Set(
	[
		"toLocaleString",
		"toLocaleDateString",
		"toLocaleTimeString",
		"toString",
		"toDateString",
		"toTimeString",
		"toUTCString",
		"toGMTString",
	].concat(
		["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds"].flatMap(
			(field) => [`get${field}`, `getUTC${field}`],
		),
	),
);

const INTL_FORMATS = new Set(["DateTimeFormat", "RelativeTimeFormat"]);

const fromLib = (program: ts.Program, symbol: ts.Symbol | undefined) =>
	(symbol?.declarations ?? []).some((d) =>
		program.isSourceFileDefaultLibrary(d.getSourceFile()),
	);

// The lib's own `Date`, so a domain type that happens to share the name is not
// mistaken for one. The apparent type answers for a `T extends Date`.
function isDate(program: ts.Program, node: ts.Expression): boolean {
	const checker = program.getTypeChecker();
	const type = checker.getApparentType(checker.getTypeAtLocation(node));
	return (type.isUnionOrIntersection() ? type.types : [type]).some((t) => {
		const symbol = t.getSymbol();
		return symbol?.getName() === "Date" && fromLib(program, symbol);
	});
}

// `Intl.DateTimeFormat().resolvedOptions()` reads the device's zone and
// produces no text, so a format built only to be asked that is not formatting.
function onlyResolvesOptions(intl: ts.PropertyAccessExpression): boolean {
	const made = intl.parent;
	if (!(ts.isCallExpression(made) || ts.isNewExpression(made))) return false;
	if (made.expression !== intl) return false;
	const read = made.parent;
	return (
		ts.isPropertyAccessExpression(read) && read.name.text === "resolvedOptions"
	);
}

/** The named function a node sits in, for exceptions granted by function. */
function enclosingFunction(node: ts.Node): string | undefined {
	for (let at = node.parent; at; at = at.parent) {
		if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
		if (
			(ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
			ts.isVariableDeclaration(at.parent) &&
			ts.isIdentifier(at.parent.name)
		) {
			return at.parent.name.text;
		}
	}
	return undefined;
}

interface Hit {
	line: number;
	what: string;
	fn?: string;
}

/** Every place in `file` that formats a date or reads its fields itself. */
function dateFormatting(program: ts.Program, file: ts.SourceFile): Hit[] {
	const found: Hit[] = [];
	const at = (node: ts.Node, what: string) => {
		const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
		found.push({ line: line + 1, what, fn: enclosingFunction(node) });
	};
	const isPlus = (kind: ts.SyntaxKind) =>
		kind === ts.SyntaxKind.PlusToken || kind === ts.SyntaxKind.PlusEqualsToken;

	const visit = (node: ts.Node) => {
		if (ts.isPropertyAccessExpression(node)) {
			const name = node.name.text;
			if (
				ts.isIdentifier(node.expression) &&
				node.expression.text === "Intl" &&
				INTL_FORMATS.has(name) &&
				!onlyResolvesOptions(node)
			) {
				at(node, `Intl.${name}`);
			} else if (DATE_METHODS.has(name) && isDate(program, node.expression)) {
				at(node, `Date#${name}`);
			}
		} else if (ts.isTemplateSpan(node) && isDate(program, node.expression)) {
			at(node, "a Date in a template literal");
		} else if (
			ts.isBinaryExpression(node) &&
			isPlus(node.operatorToken.kind) &&
			(isDate(program, node.left) || isDate(program, node.right))
		) {
			at(node, "a Date concatenated into a string");
		} else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			const callee = node.expression.text;
			const symbol = program
				.getTypeChecker()
				.getSymbolAtLocation(node.expression);
			if (callee === "Date" && fromLib(program, symbol)) {
				// `Date()` without `new` is the current time already as text.
				at(node, "Date() called as a function");
			} else if (
				callee === "String" &&
				node.arguments.length === 1 &&
				isDate(program, node.arguments[0])
			) {
				at(node, "String(date)");
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

function readOptions(): ts.CompilerOptions {
	const fail = (diagnostics: readonly ts.Diagnostic[]) => {
		throw new Error(
			diagnostics
				.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
				.join("\n"),
		);
	};
	const parsed = ts.getParsedCommandLineOfConfigFile(
		resolve("tsconfig.app.json"),
		{},
		{ ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => fail([d]) },
	);
	if (!parsed) throw new Error("tsconfig.app.json could not be read");
	if (parsed.errors.length > 0) fail(parsed.errors);
	return parsed.options;
}

const options = readOptions();

// Built once and shared: making the program is most of the scan's cost.
let app: ts.Program | undefined;
const appProgram = () => {
	app ??= ts.createProgram(sourceFiles("src"), options);
	return app;
};

const appFile = (path: string) => {
	const file = appProgram().getSourceFile(resolve("..", path));
	if (!file) throw new Error(`${path} is not in the scanned program`);
	return file;
};

const CATCHES: [name: string, source: string, what: string][] = [
	[
		"toLocaleTimeString",
		"new Date().toLocaleTimeString();",
		"Date#toLocaleTimeString",
	],
	["toLocaleString", "new Date(iso).toLocaleString();", "Date#toLocaleString"],
	[
		"a nullable date",
		"declare const d: Date | null; d?.toLocaleDateString();",
		"Date#toLocaleDateString",
	],
	[
		"a date-bounded generic",
		"export const f = <T extends Date>(d: T) => d.toLocaleString();",
		"Date#toLocaleString",
	],
	[
		"a hand-padded clock",
		'String(new Date().getHours()).padStart(2, "0");',
		"Date#getHours",
	],
	[
		"an Intl format",
		'new Intl.DateTimeFormat("en-US", { hour: "2-digit" });',
		"Intl.DateTimeFormat",
	],
	[
		"an Intl format by call",
		"Intl.DateTimeFormat().format(0);",
		"Intl.DateTimeFormat",
	],
	[
		"a relative format",
		'new Intl.RelativeTimeFormat("en").format(-1, "day");',
		"Intl.RelativeTimeFormat",
	],
	["a template literal", `\`at \${new Date()}\`;`, "template literal"],
	["concatenation", '"at " + new Date();', "concatenated"],
	["appending", 'let s = "at "; s += new Date();', "concatenated"],
	["String()", "String(new Date());", "String(date)"],
	["Date()", "Date();", "Date() called as a function"],
];

const LEAVES: [name: string, source: string][] = [
	["a number's locale string", 'const n = 1234; n.toLocaleString("en-US");'],
	["a number's string", "(42).toString();"],
	["serialisation", "new Date().toISOString(); new Date().getTime();"],
	[
		"reading the device zone",
		"Intl.DateTimeFormat().resolvedOptions().timeZone;",
	],
	["an options type", "export const o: Intl.DateTimeFormatOptions = {};"],
	["a number in a template", `const n = 3; \`\${n} files\`;`],
	[
		"a type of our own named Date",
		"type Date = { toString(): string }; declare const d: Date; d.toString();",
	],
];

// Every case as its own in-memory module, all in one program so the lib is
// checked once rather than once per case. The host hands each file the
// program's own parse options: those carry `moduleDetection: force`, without
// which the cases would share one global scope.
const cases = (() => {
	const path = (name: string) => resolve(`tests/__case__/${name}.ts`);
	const sources = new Map(
		[...CATCHES, ...LEAVES].map(([name, source]) => [
			path(name),
			`declare const iso: string;\n${source}`,
		]),
	);
	const host = ts.createCompilerHost(options);
	const { getSourceFile, fileExists } = host;
	host.getSourceFile = (fileName, parseOptions, ...rest) => {
		const source = sources.get(fileName);
		return source === undefined
			? getSourceFile(fileName, parseOptions, ...rest)
			: ts.createSourceFile(fileName, source, parseOptions, true);
	};
	host.fileExists = (fileName) => sources.has(fileName) || fileExists(fileName);
	const program = ts.createProgram([...sources.keys()], options, host);
	const file = (name: string) =>
		program.getSourceFile(path(name)) as ts.SourceFile;
	return {
		hits: (name: string) =>
			dateFormatting(program, file(name)).map((hit) => hit.what),
		// A case that does not compile proves nothing about real code.
		errors: (name: string) =>
			program
				.getSemanticDiagnostics(file(name))
				.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
	};
})();

describe("date formatting", () => {
	it(`happens only in ${MODULE}`, () => {
		const program = appProgram();
		const faults = sourceFiles("src").flatMap((f) => {
			const path = repoPath(f);
			const entitled = ENTITLED[path];
			if (entitled === "whole file") return [];
			return dateFormatting(program, appFile(path))
				.filter((hit) => !(hit.fn && entitled?.includes(hit.fn)))
				.map(
					(hit) =>
						`${path}:${hit.line}: ${hit.what}\n  formats a date or reads its fields itself; ${REMEDY}`,
				);
		});
		expect(faults).toEqual([]);
	}, 60_000);

	// An exception nobody needs any more pre-approves the next violation there.
	it.each(
		Object.entries(ENTITLED).flatMap(([path, scope]) =>
			scope === "whole file"
				? [{ path, scope }]
				: scope.map((name) => ({ path, scope: name })),
		),
	)("$path $scope still needs its exception", ({ path, scope }) => {
		const hits = dateFormatting(appProgram(), appFile(path));
		expect(
			hits.filter((hit) => scope === "whole file" || hit.fn === scope),
		).not.toEqual([]);
	}, 60_000);

	it.each(CATCHES)("catches %s", (name, _source, what) => {
		expect(cases.errors(name)).toEqual([]);
		const hits = cases.hits(name);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toContain(what);
	});

	it.each(LEAVES)("leaves %s alone", (name) => {
		expect(cases.errors(name)).toEqual([]);
		expect(cases.hits(name)).toEqual([]);
	});
});
