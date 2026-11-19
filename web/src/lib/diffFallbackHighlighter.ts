/**
 * Stands in for `@git-diff-view/lowlight`: the Vite and Vitest configs alias
 * that package to this module. The library imports it statically, and the
 * real one registers every highlight.js grammar when it loads, which put all
 * of them in the entry chunk. Shiki colours diffs (shikiUtils.tsx); this
 * module is what the library falls back to for a language shiki lacks. It
 * starts with no grammars and loads one only when a diff in a language shiki
 * has no grammar for, but highlight.js does, is opened.
 *
 * A language it has not loaded is drawn as plain text, never guessed at:
 * the real module would hand it to highlight.js's auto-detection.
 */
import type { DiffHighlighter } from "@git-diff-view/react";
import { processAST } from "@git-diff-view/shiki";
import type { LanguageFn } from "highlight.js";
import { createLowlight } from "lowlight";

type GrammarModule = Promise<{ default: LanguageFn }>;

/**
 * The highlight.js grammars for languages shiki has none for, by name. These
 * are every highlight.js language whose name and aliases shiki does not know
 * (apart from its plain text); `HLJS_EXTENSIONS` lists the extensions that
 * reach them. Each is a chunk of its own, fetched on first use.
 */
const HLJS_ONLY: Record<string, () => GrammarModule> = {
	abnf: () => import("highlight.js/lib/languages/abnf"),
	accesslog: () => import("highlight.js/lib/languages/accesslog"),
	angelscript: () => import("highlight.js/lib/languages/angelscript"),
	arcade: () => import("highlight.js/lib/languages/arcade"),
	armasm: () => import("highlight.js/lib/languages/armasm"),
	aspectj: () => import("highlight.js/lib/languages/aspectj"),
	autohotkey: () => import("highlight.js/lib/languages/autohotkey"),
	autoit: () => import("highlight.js/lib/languages/autoit"),
	avrasm: () => import("highlight.js/lib/languages/avrasm"),
	axapta: () => import("highlight.js/lib/languages/axapta"),
	basic: () => import("highlight.js/lib/languages/basic"),
	bnf: () => import("highlight.js/lib/languages/bnf"),
	brainfuck: () => import("highlight.js/lib/languages/brainfuck"),
	cal: () => import("highlight.js/lib/languages/cal"),
	capnproto: () => import("highlight.js/lib/languages/capnproto"),
	ceylon: () => import("highlight.js/lib/languages/ceylon"),
	clean: () => import("highlight.js/lib/languages/clean"),
	"clojure-repl": () => import("highlight.js/lib/languages/clojure-repl"),
	cos: () => import("highlight.js/lib/languages/cos"),
	crmsh: () => import("highlight.js/lib/languages/crmsh"),
	csp: () => import("highlight.js/lib/languages/csp"),
	dns: () => import("highlight.js/lib/languages/dns"),
	dsconfig: () => import("highlight.js/lib/languages/dsconfig"),
	dts: () => import("highlight.js/lib/languages/dts"),
	dust: () => import("highlight.js/lib/languages/dust"),
	ebnf: () => import("highlight.js/lib/languages/ebnf"),
	"erlang-repl": () => import("highlight.js/lib/languages/erlang-repl"),
	excel: () => import("highlight.js/lib/languages/excel"),
	fix: () => import("highlight.js/lib/languages/fix"),
	flix: () => import("highlight.js/lib/languages/flix"),
	gams: () => import("highlight.js/lib/languages/gams"),
	gauss: () => import("highlight.js/lib/languages/gauss"),
	gcode: () => import("highlight.js/lib/languages/gcode"),
	gml: () => import("highlight.js/lib/languages/gml"),
	golo: () => import("highlight.js/lib/languages/golo"),
	hsp: () => import("highlight.js/lib/languages/hsp"),
	inform7: () => import("highlight.js/lib/languages/inform7"),
	irpf90: () => import("highlight.js/lib/languages/irpf90"),
	isbl: () => import("highlight.js/lib/languages/isbl"),
	"jboss-cli": () => import("highlight.js/lib/languages/jboss-cli"),
	"julia-repl": () => import("highlight.js/lib/languages/julia-repl"),
	lasso: () => import("highlight.js/lib/languages/lasso"),
	ldif: () => import("highlight.js/lib/languages/ldif"),
	leaf: () => import("highlight.js/lib/languages/leaf"),
	livecodeserver: () => import("highlight.js/lib/languages/livecodeserver"),
	livescript: () => import("highlight.js/lib/languages/livescript"),
	lsl: () => import("highlight.js/lib/languages/lsl"),
	maxima: () => import("highlight.js/lib/languages/maxima"),
	mel: () => import("highlight.js/lib/languages/mel"),
	mercury: () => import("highlight.js/lib/languages/mercury"),
	mizar: () => import("highlight.js/lib/languages/mizar"),
	mojolicious: () => import("highlight.js/lib/languages/mojolicious"),
	monkey: () => import("highlight.js/lib/languages/monkey"),
	moonscript: () => import("highlight.js/lib/languages/moonscript"),
	n1ql: () => import("highlight.js/lib/languages/n1ql"),
	nestedtext: () => import("highlight.js/lib/languages/nestedtext"),
	"node-repl": () => import("highlight.js/lib/languages/node-repl"),
	nsis: () => import("highlight.js/lib/languages/nsis"),
	oxygene: () => import("highlight.js/lib/languages/oxygene"),
	parser3: () => import("highlight.js/lib/languages/parser3"),
	pf: () => import("highlight.js/lib/languages/pf"),
	"php-template": () => import("highlight.js/lib/languages/php-template"),
	pony: () => import("highlight.js/lib/languages/pony"),
	processing: () => import("highlight.js/lib/languages/processing"),
	profile: () => import("highlight.js/lib/languages/profile"),
	purebasic: () => import("highlight.js/lib/languages/purebasic"),
	"python-repl": () => import("highlight.js/lib/languages/python-repl"),
	q: () => import("highlight.js/lib/languages/q"),
	reasonml: () => import("highlight.js/lib/languages/reasonml"),
	rib: () => import("highlight.js/lib/languages/rib"),
	roboconf: () => import("highlight.js/lib/languages/roboconf"),
	routeros: () => import("highlight.js/lib/languages/routeros"),
	rsl: () => import("highlight.js/lib/languages/rsl"),
	ruleslanguage: () => import("highlight.js/lib/languages/ruleslanguage"),
	scilab: () => import("highlight.js/lib/languages/scilab"),
	smali: () => import("highlight.js/lib/languages/smali"),
	sml: () => import("highlight.js/lib/languages/sml"),
	sqf: () => import("highlight.js/lib/languages/sqf"),
	stan: () => import("highlight.js/lib/languages/stan"),
	step21: () => import("highlight.js/lib/languages/step21"),
	subunit: () => import("highlight.js/lib/languages/subunit"),
	taggerscript: () => import("highlight.js/lib/languages/taggerscript"),
	tap: () => import("highlight.js/lib/languages/tap"),
	thrift: () => import("highlight.js/lib/languages/thrift"),
	tp: () => import("highlight.js/lib/languages/tp"),
	"vbscript-html": () => import("highlight.js/lib/languages/vbscript-html"),
	wren: () => import("highlight.js/lib/languages/wren"),
	x86asm: () => import("highlight.js/lib/languages/x86asm"),
	xl: () => import("highlight.js/lib/languages/xl"),
	xquery: () => import("highlight.js/lib/languages/xquery"),
	zephir: () => import("highlight.js/lib/languages/zephir"),
};

/**
 * Grammars the ones above embed. highlight.js draws an embedded language it
 * does not have as plain text, so these are loaded alongside — the real
 * module had them all registered, and the embedded code was coloured.
 */
const EMBEDDED: Record<string, () => GrammarModule> = {
	clojure: () => import("highlight.js/lib/languages/clojure"),
	css: () => import("highlight.js/lib/languages/css"),
	graphql: () => import("highlight.js/lib/languages/graphql"),
	handlebars: () => import("highlight.js/lib/languages/handlebars"),
	javascript: () => import("highlight.js/lib/languages/javascript"),
	julia: () => import("highlight.js/lib/languages/julia"),
	perl: () => import("highlight.js/lib/languages/perl"),
	php: () => import("highlight.js/lib/languages/php"),
	python: () => import("highlight.js/lib/languages/python"),
	ruby: () => import("highlight.js/lib/languages/ruby"),
	sql: () => import("highlight.js/lib/languages/sql"),
	vbscript: () => import("highlight.js/lib/languages/vbscript"),
	xml: () => import("highlight.js/lib/languages/xml"),
	yaml: () => import("highlight.js/lib/languages/yaml"),
};

/**
 * Every language each one embeds, through the whole chain (PHP templates
 * embed XML, which embeds CSS), so a load is one flat batch: perl and
 * mojolicious embed each other, and a load that followed the chain itself
 * would wait on its own completion.
 */
const EMBEDS: Record<string, string[]> = {
	"clojure-repl": ["clojure"],
	cos: ["css", "graphql", "handlebars", "javascript", "sql", "xml"],
	dust: ["css", "graphql", "handlebars", "javascript", "xml"],
	"julia-repl": ["julia"],
	livescript: ["css", "graphql", "handlebars", "javascript", "xml"],
	mojolicious: ["css", "graphql", "handlebars", "javascript", "perl", "xml"],
	"node-repl": ["css", "graphql", "handlebars", "javascript", "xml"],
	parser3: ["css", "graphql", "handlebars", "javascript", "xml"],
	"php-template": ["css", "graphql", "handlebars", "javascript", "php", "xml"],
	"python-repl": ["python"],
	tap: ["ruby", "yaml"],
	"vbscript-html": [
		"css",
		"graphql",
		"handlebars",
		"javascript",
		"vbscript",
		"xml",
	],
	xquery: ["css", "graphql", "handlebars", "javascript", "xml"],
};

/**
 * Extensions that reach a language above other than by its own name: the
 * highlight.js aliases of those languages, which is what the real module
 * matched a file's extension against. `ls` was LiveScript there too, the
 * later of the two languages that claim it.
 */
const HLJS_EXTENSIONS: Record<string, string> = {
	asc: "angelscript",
	arm: "armasm",
	ahk: "autohotkey",
	"x++": "axapta",
	bf: "brainfuck",
	capnp: "capnproto",
	icl: "clean",
	dcl: "clean",
	cls: "cos",
	crm: "crmsh",
	pcmk: "crmsh",
	bind: "dns",
	zone: "dns",
	dst: "dust",
	xlsx: "excel",
	xls: "excel",
	gms: "gams",
	gss: "gauss",
	nc: "gcode",
	i7: "inform7",
	"wildfly-cli": "jboss-cli",
	jldoctest: "julia-repl",
	lassoscript: "lasso",
	ls: "livescript",
	moo: "mercury",
	moon: "moonscript",
	nt: "nestedtext",
	pde: "processing",
	pb: "purebasic",
	pbi: "purebasic",
	pycon: "python-repl",
	k: "q",
	kdb: "q",
	re: "reasonml",
	graph: "roboconf",
	instances: "roboconf",
	mikrotik: "routeros",
	sci: "scilab",
	stanfuncs: "stan",
	p21: "step21",
	step: "step21",
	stp: "step21",
	tao: "xl",
	xpath: "xquery",
	xq: "xquery",
	xqm: "xquery",
	zep: "zephir",
};

/**
 * The highlight.js language for a file extension (lower case) shiki has no
 * grammar for, or undefined when highlight.js has none either.
 */
export function hljsLanguageForExtension(ext: string): string | undefined {
	if (Object.hasOwn(HLJS_EXTENSIONS, ext)) return HLJS_EXTENSIONS[ext];
	return Object.hasOwn(HLJS_ONLY, ext) ? ext : undefined;
}

export function isHljsLanguage(language: string): boolean {
	return Object.hasOwn(HLJS_ONLY, language);
}

const lowlight = createLowlight();
const grammarLoads = new Map<string, Promise<void>>();

async function loadGrammar(
	name: string,
	load: () => GrammarModule,
): Promise<void> {
	if (lowlight.registered(name)) return;
	let loading = grammarLoads.get(name);
	if (!loading) {
		// Not remembered once settled: a grammar is a chunk fetched over the
		// network, and a failed one may well arrive next time.
		loading = (async () => {
			const grammar = (await load()).default;
			lowlight.register(name, grammar);
		})().finally(() => grammarLoads.delete(name));
		grammarLoads.set(name, loading);
	}
	return loading;
}

/**
 * Loads a language `isHljsLanguage` accepts, with the languages it embeds.
 * Rejects when its own grammar cannot be had; an embedded one that fails
 * leaves only that part plain.
 */
export async function loadHljsLanguage(language: string): Promise<void> {
	const embeds = (EMBEDS[language] ?? []).map((name) =>
		loadGrammar(name, EMBEDDED[name]).catch((error) => {
			console.error(
				`Diff: could not load the ${name} grammar embedded in ${language}`,
				error,
			);
		}),
	);
	await Promise.all([loadGrammar(language, HLJS_ONLY[language]), ...embeds]);
}

let maxLineToIgnoreSyntax = 2000;
const ignoreSyntaxHighlightList: (string | RegExp)[] = [];

export const highlighter: DiffHighlighter = {
	name: "lowlight",
	type: "class",
	get maxLineToIgnoreSyntax() {
		return maxLineToIgnoreSyntax;
	},
	setMaxLineToIgnoreSyntax: (value) => {
		maxLineToIgnoreSyntax = value;
	},
	ignoreSyntaxHighlightList,
	setIgnoreSyntaxHighlightList: (value) => {
		ignoreSyntaxHighlightList.splice(0, Infinity, ...value);
	},
	getAST: (raw, fileName, lang) => {
		const ignored =
			fileName &&
			ignoreSyntaxHighlightList.some((item) =>
				item instanceof RegExp ? item.test(fileName) : item === fileName,
			);
		return lang && !ignored && lowlight.registered(lang)
			? lowlight.highlight(lang, raw)
			: { type: "root", children: [{ type: "text", value: raw }] };
	},
	processAST,
	hasRegisteredCurrentLang: (lang) => lowlight.registered(lang),
	getHighlighterEngine: () => lowlight,
};

// The library re-exports this module whole; nothing reads its other
// exports (`_getAST`, a type helper, and `versions`), so they are left out.
export { processAST };
