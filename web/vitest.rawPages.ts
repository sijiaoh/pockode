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
	png: "image/png",
	webm: "video/webm",
	wav: "audio/wav",
};

/**
 * `/api/raw` for the real-browser tests: `src/test/page-hosts/` as the root
 * of a project, read under a capability as the server serves it — with its
 * sandbox, its policy and, framed, its reporter, all read from
 * `raw-contract.json`, which the server's own tests keep in step with what it
 * sends. So what the engines enforce is the server's, not a copy of it.
 *
 * A capability names the hosts the server would have bound to it, since
 * nothing here keeps any: `<id>~<host>~<host>`, a host's `:` written `_`.
 * `{{OTHER}}` in a page is the test server's other name (`otherHost` in
 * `src/test/testServerHosts.ts`), which stands in for another host. Media is
 * served whole or by a byte range, as WebKit asks for it.
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

				let bytes: Buffer;
				try {
					bytes = readFileSync(new URL(file, HERE));
				} catch {
					res.statusCode = 404;
					res.end(JSON.stringify({ code: "not_found" }));
					return;
				}
				const type = TYPES[file.split(".").pop() ?? ""] ?? "text/plain";
				res.setHeader("Content-Type", type);
				if (!type.startsWith("text/")) {
					res.setHeader("Accept-Ranges", "bytes");
					const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
					if (!range) {
						res.end(bytes);
						return;
					}
					// `bytes=-N` is the last N bytes.
					const start = range[1]
						? Number(range[1])
						: Math.max(0, bytes.length - Number(range[2]));
					const end =
						range[1] && range[2]
							? Math.min(Number(range[2]), bytes.length - 1)
							: bytes.length - 1;
					if (start >= bytes.length || start > end) {
						res.statusCode = 416;
						res.setHeader("Content-Range", `bytes */${bytes.length}`);
						res.end();
						return;
					}
					res.statusCode = 206;
					res.setHeader(
						"Content-Range",
						`bytes ${start}-${end}/${bytes.length}`,
					);
					res.end(bytes.subarray(start, end + 1));
					return;
				}
				let body = bytes
					.toString("utf8")
					.replaceAll("{{OTHER}}", otherHost(host.split(":")[1]));
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
