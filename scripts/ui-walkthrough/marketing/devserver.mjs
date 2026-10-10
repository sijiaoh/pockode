// tidy's dev server, as the user would have it running while they look at it
// through Port Preview: the page docs/marketing-assets.md §8.4 draws, served
// static so it is the same every run. run.sh starts it beside the server, in
// the project, on WALKTHROUGH_DEV_SERVER_PORT, and `down` stops it with the server.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const PAGE = readFileSync(join(import.meta.dirname, "tidy.html"));
const PORT = Number(process.env.WALKTHROUGH_DEV_SERVER_PORT);

createServer((req, res) => {
	if (req.url !== "/") {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
}).listen(PORT, "127.0.0.1");
