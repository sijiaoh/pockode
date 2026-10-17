import { afterEach, describe, expect, it } from "vitest";
import {
	addRefusal,
	allowedPageHosts,
	allowPageHosts,
	capabilityRoot,
	MAX_ALLOWED_HOSTS,
	MAX_LISTED_HOSTS,
	NO_REFUSALS,
	pagePolicy,
	rawPageWrapper,
	readPageReport,
	refusedHost,
	resetPageHosts,
} from "./pageHosts";

function directive(policy: string, name: string): string[] {
	const found = policy
		.split(";")
		.map((part) => part.trim().split(/\s+/))
		.find(([head]) => head === name);
	return found ? found.slice(1) : [];
}

describe("pagePolicy", () => {
	it("refuses every host until one is allowed, and keeps what pages need", () => {
		const policy = pagePolicy([]);

		expect(directive(policy, "default-src")).toEqual(["data:", "blob:"]);
		expect(directive(policy, "script-src")).toEqual([
			"'unsafe-inline'",
			"'unsafe-eval'",
			"data:",
			"blob:",
		]);
		expect(policy).not.toContain("'self'");
		expect(policy).not.toContain("*");
	});

	it("names an allowed host over every scheme, for every kind of request", () => {
		const policy = pagePolicy(["cdn.example:8443"]);
		const sources = [
			"http://cdn.example:8443",
			"https://cdn.example:8443",
			"ws://cdn.example:8443",
			"wss://cdn.example:8443",
		];

		for (const name of ["default-src", "script-src", "style-src"]) {
			expect(directive(policy, name)).toEqual(expect.arrayContaining(sources));
		}
	});

	// The page frame's own navigations are held by this directive in the
	// document embedding it; an allowed host there would let the page leave
	// for a document under no policy.
	it("never lets a document be embedded from a host, allowed or not", () => {
		for (const name of ["frame-src", "object-src"]) {
			expect(directive(pagePolicy(["cdn.example"]), name)).toEqual(["'none'"]);
		}
		expect(directive(pagePolicy(["cdn.example"]), "form-action")).toEqual([
			"'none'",
		]);
	});
});

describe("capabilityRoot", () => {
	it.each([
		["a root capability", "https://app.example/api/raw/cap1/"],
		["a file capability", "https://app.example/api/raw/cap1/a%20b.html"],
	])("is the prefix of what %s reaches", (_, url) => {
		expect(capabilityRoot(url)).toBe("https://app.example/api/raw/cap1/");
	});
});

describe("rawPageWrapper", () => {
	// The page's own frame may go anywhere its capability reaches, and nowhere
	// else: not to a host, nor to another capability — however deep the page
	// sits beneath it.
	it("holds the page to its capability", () => {
		const meta = new DOMParser()
			.parseFromString(
				rawPageWrapper(
					"https://app.example/api/raw/cap1/docs/site/page.html",
					"https://app.example/api/raw/cap1/",
					"Page",
					"allow-scripts",
				),
				"text/html",
			)
			.querySelector('meta[http-equiv="Content-Security-Policy"]');
		const policy = meta?.getAttribute("content") ?? "";
		expect(directive(policy, "default-src")).toEqual(["'none'"]);
		expect(directive(policy, "frame-src")).toEqual([
			"https://app.example/api/raw/cap1/",
		]);
	});
});

describe("refusedHost", () => {
	it("names a refused request by its host, port included", () => {
		expect(refusedHost("https://CDN.Example:8443/a.js?q", "app.test")).toEqual({
			host: "cdn.example:8443",
			allowable: true,
		});
		expect(refusedHost("wss://live.example/socket", "app.test")).toEqual({
			host: "live.example",
			allowable: true,
		});
	});

	it("lists what no policy here can allow, rather than dropping it", () => {
		const own = refusedHost("http://app.test:9999/x", "app.test");
		const ownWithDot = refusedHost("http://app.test.:9999/x", "app.test");
		const ipv6 = refusedHost("https://[::1]/x", "app.test");
		const underscore = refusedHost("https://a_b.example/x", "app.test");
		const ftp = refusedHost("ftp://files.example/x", "app.test");

		for (const refused of [own, ownWithDot, ipv6, underscore, ftp]) {
			expect(refused?.allowable).toBe(false);
		}
		expect(ipv6?.host).toBe("[::1]");
	});

	it("has nothing to say of a refusal with no host", () => {
		expect(refusedHost("inline", "app.test")).toBeNull();
		expect(refusedHost("data:text/plain,x", "app.test")).toBeNull();
	});
});

describe("addRefusal", () => {
	const host = (name: string) => ({ host: name, allowable: true });

	it("keeps the order hosts were first refused, each once", () => {
		let list = NO_REFUSALS;
		for (const name of ["b.example", "a.example", "b.example"]) {
			list = addRefusal(list, host(name));
		}

		expect(list.hosts.map((entry) => entry.host)).toEqual([
			"b.example",
			"a.example",
		]);
	});

	// A frame from a host is never allowed, a script from it may be: which
	// the page asked for first must not decide whether Load is offered.
	it("offers a host refused for a frame once it is refused for more", () => {
		let list = addRefusal(NO_REFUSALS, { host: "a.example", allowable: true });
		list = addRefusal(list, {
			host: "video.example",
			allowable: false,
			embedded: true,
		});
		list = addRefusal(list, { host: "video.example", allowable: true });
		list = addRefusal(list, {
			host: "video.example",
			allowable: false,
			embedded: true,
		});

		expect(list.hosts).toEqual([
			{ host: "a.example", allowable: true },
			{ host: "video.example", allowable: true },
		]);
	});

	// The server binds no more to a page's capability, however many Loads.
	it("offers no more than a page may be allowed in all", () => {
		const allowed = new Set(
			Array.from({ length: MAX_ALLOWED_HOSTS - 2 }, (_, i) => `a${i}.example`),
		);
		let list = NO_REFUSALS;
		for (const host of [
			"b1.example",
			"a0.example",
			"b2.example",
			"b3.example",
		]) {
			list = addRefusal(list, { host, allowable: true }, allowed);
		}
		expect(list.hosts.map((entry) => entry.allowable)).toEqual([
			true,
			true,
			true,
			false,
		]);
	});

	it("stops listing at the cap, and says more were refused", () => {
		let list = NO_REFUSALS;
		for (let i = 0; i <= MAX_LISTED_HOSTS; i++) {
			list = addRefusal(list, host(`h${i}.example`));
		}

		expect(list.hosts).toHaveLength(MAX_LISTED_HOSTS);
		expect(list.overflow).toBe(true);
	});
});

describe("readPageReport", () => {
	it("takes only the shapes a page's reporter sends", () => {
		expect(
			readPageReport({
				type: "pockode:page-refused",
				url: "https://a.example/",
				directive: "img-src",
			}),
		).toEqual({
			type: "refused",
			url: "https://a.example/",
			directive: "img-src",
		});
		expect(
			readPageReport({ type: "pockode:page-refused", url: 1, directive: "" }),
		).toBeNull();
		// Nothing a page can say allows anything: there is no such message.
		expect(
			readPageReport({ type: "pockode:page-allow", hosts: ["a.example"] }),
		).toBeNull();
	});
});

describe("the allowance", () => {
	afterEach(resetPageHosts);

	it("is for the page it was given on, and no other", () => {
		allowPageHosts("call-1", ["cdn.example"]);

		expect(allowedPageHosts("call-1").has("cdn.example")).toBe(true);
		expect(allowedPageHosts("call-2").size).toBe(0);
	});
});
