// The copy the finished assets carry, read from site/data/messaging.yaml —
// the one place Pockode's public wording is written, which the site and the
// README read too. Nothing here words a claim of its own: a renderer takes
// what it shows from `messaging`, so a copy edit there is a re-render here,
// never an edit.

import { readFileSync } from "node:fs";
import { join } from "node:path";
// The workspace's own (the root package.json), as the README generator reads
// the same file with: the renderers need `pnpm install` already, for the
// app's icons (stills/architecture.mjs).
import { parse } from "yaml";

const PROJECT_DIR = join(import.meta.dirname, "../../..");
const FILE = join(PROJECT_DIR, "site/data/messaging.yaml");
const source = parse(readFileSync(FILE, "utf8"));

/** A field of the source, refused if it is missing or empty. */
function field(path) {
	const value = path.split(".").reduce((node, key) => node?.[key], source);
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${FILE} has no ${path}, which the marketing assets show.`);
	return value;
}

// The first installer is the one the README and the site lead with. The
// terminal shows its run command as typed, with the password masked; one
// without a password would leave the shot showing a placeholder.
const run = field("quickstart.installers.0.run");
const PASSWORD_ARG = /(-password )\S+/;
if (!PASSWORD_ARG.test(run))
	throw new Error(
		`${FILE}'s first installer runs \`${run}\`, with no -password for the video's terminal to mask.`,
	);

export const messaging = {
	name: field("name"),
	host: new URL(field("url")).host,
	tagline: field("tagline"),
	subtitle: field("subtitle"),
	license: field("license.label"),
	install: field("quickstart.installers.0.install"),
	run: run.replace(PASSWORD_ARG, "$1••••••••"),
};

export const escapeHtml = (s) =>
	s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** A source value as markup: escaped, its `code` spans (the source's one markup) as <code>. */
export const inline = (text) =>
	escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
