import assert from "node:assert/strict";
import { test } from "node:test";
import { mentions, parseDefaults, problem } from "./flags.mjs";

const named = (text, prose = true) =>
	mentions(text, prose).map((m) => `${m.command}:${m.written}`);

test("a pockode command line names its flags, cluster ones against cluster", () => {
	assert.deepEqual(named("pockode -password X -relay=false"), [
		"server:-password",
		"server:-relay=false",
	]);
	assert.deepEqual(named("/usr/local/bin/pockode cluster --port 1"), [
		"cluster:--port",
	]);
	assert.deepEqual(named("Run 'pockode -password X' to get started.", false), [
		"server:-password",
	]);
});

test("the command line ends with its code span, string or pipeline", () => {
	assert.deepEqual(named("`pockode -dev` then `sh -s -- --version 1`"), [
		"server:-dev",
	]);
	assert.deepEqual(named("pockode -dev | tee --append log"), ["server:-dev"]);
});

test("other tools, host names and prose are not the command", () => {
	assert.deepEqual(
		named("curl https://pockode.com/install.sh | sh -s -- --version 1"),
		[],
	);
	assert.deepEqual(named("pockode-linux-amd64 -x; .pockode/ -y"), []);
	assert.deepEqual(
		named("until `pockode` finds it, pockode mcp --data-dir d"),
		[],
	);
});

test("a code span that is only a flag counts in prose files only", () => {
	assert.deepEqual(named("Add `-relay=false` or <code>--dev</code>."), [
		"server:-relay=false",
		"server:--dev",
	]);
	assert.deepEqual(named("Add `-relay=false`.", false), []);
	assert.deepEqual(named("`-relay=false to disable`"), []);
});

test("PrintDefaults output parses to names and usage", () => {
	const flags = parseDefaults(
		[
			"Flags:",
			"  -auth-token string",
			"    \tdeprecated alias for -password",
			"  -dev",
			"    \tenable development mode",
			"  -x int\tone letter",
		].join("\n"),
	);
	assert.deepEqual(
		[...flags],
		[
			["auth-token", "deprecated alias for -password"],
			["dev", "enable development mode"],
			["x", "one letter"],
		],
	);
});

test("unknown, deprecated and double-dash flags are problems", () => {
	const server = new Map([
		["password", "password for the web UI"],
		["auth-token", "deprecated alias for -password"],
	]);
	const sets = { server, cluster: new Map() };
	const check = (text) => mentions(text, true).map((m) => problem(m, sets));
	assert.deepEqual(check("pockode -password X -h"), [null, null]);
	assert.match(check("pockode -nope")[0], /not a flag of `pockode`/);
	assert.match(
		check("pockode cluster -password X")[0],
		/not a flag of `pockode cluster`/,
	);
	assert.match(check("pockode -auth-token X")[0], /deprecated/);
	assert.match(check("pockode --password X")[0], /two dashes/);
});
