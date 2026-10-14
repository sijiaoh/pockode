import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { otherHost } from "./src/test/testServerHosts";

const HERE = new URL("./src/test/page-hosts/", import.meta.url);

interface Contract {
	sandbox: string;
	capability: string;
	base: string;
	host: string;
	policy: string;
	policyWithHost: string;
	reporter: string;
}

function hostSources(host: string) {
	return `http://${host} https://${host} ws://${host} wss://${host}`;
}

const TYPES: Record<string, string> = {
	htm: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
};

/**
 * `/api/raw` for the real-browser tests: the pages in
 * `src/test/page-hosts/site/`, each under a capability as the server serves
 * it — with its sandbox, its policy and, framed, its reporter, all read from
 * `raw-contract.json`, which the server's own tests keep in step with what it
 * sends. So what the engines enforce is the server's, not a copy of it.
 *
 * A capability names the hosts the server would have bound to it, since
 * nothing here keeps any: `<id>~<host>~<host>`, a host's `:` written `_`.
 * `{{OTHER}}` in a page is the test server's other name (`otherHost` in
 * `src/test/testServerHosts.ts`), which stands in for another host.
 */
export function rawPages(): Plugin {
	return {
		name: "raw-pages",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const match = req.url?.match(/^\/api\/raw\/([^/]+)\/([^?]*)/);
				if (!match) return next();
				const [, capability, file] = match;
				const contract: Contract = JSON.parse(
					readFileSync(new URL("raw-contract.json", HERE), "utf8"),
				);
				const host = req.headers.host ?? "";
				const hosts = capability
					.split("~")
					.slice(1)
					.map((entry) => entry.replace("_", ":"));
				const policy = (
					hosts.length === 0
						? contract.policy
						: contract.policyWithHost.replaceAll(
								hostSources(contract.host),
								hosts.map(hostSources).join(" "),
							)
				)
					.replaceAll(contract.base, `http://${host}`)
					.replaceAll(contract.capability, capability);
				res.setHeader(
					"Content-Security-Policy",
					`${contract.sandbox}; ${policy}`,
				);
				res.setHeader("Access-Control-Allow-Origin", "*");
				res.setHeader("Cache-Control", "no-store");

				let body: string;
				try {
					body = readFileSync(new URL(`site/${file}`, HERE), "utf8");
				} catch {
					res.statusCode = 404;
					res.end(JSON.stringify({ code: "not_found" }));
					return;
				}
				body = body.replaceAll("{{OTHER}}", otherHost(host.split(":")[1]));
				const type = TYPES[file.split(".").pop() ?? ""] ?? "text/plain";
				res.setHeader("Content-Type", type);
				if (
					type.startsWith("text/html") &&
					req.headers["sec-fetch-dest"] === "iframe"
				) {
					// After a doctype, as the server puts it; the cases around it are
					// the server's own tests'.
					const reporter = contract.reporter.replaceAll(
						contract.capability,
						capability,
					);
					const doctype = body.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? "";
					body = doctype + reporter + body.slice(doctype.length);
				}
				res.end(body);
			});
		},
	};
}
