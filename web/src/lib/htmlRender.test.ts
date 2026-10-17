import { describe, expect, it } from "vitest";
import { projectRelativeHtml } from "./htmlRender";

describe("projectRelativeHtml", () => {
	it("makes a work-directory path relative where an attribute or url() starts one", () => {
		const html = `<img src="/home/me/project/a.png"><video SRC='file:///home/me/project/v/b.webm'></video><div style="background: url( '/home/me/project/c.png')"></div><img src=/home/me/project/d.png>`;

		expect(projectRelativeHtml(html, "/home/me/project")).toBe(
			`<img src="a.png"><video SRC='v/b.webm'></video><div style="background: url( 'c.png')"></div><img src=d.png>`,
		);
	});

	it("leaves what the page shows the reader, and paths outside the work directory, as written", () => {
		const html = `<p>Saved to /home/me/project/a.png</p><pre>git add "/home/me/project/x.go"</pre><code>PATH=/home/me/project/bin</code><script>const files = ["/home/me/project/a.go"];</script><img src="/home/me/project2/a.png"><img src="/home/me/a.png"><img src="/HOME/me/project/a.png">`;

		expect(projectRelativeHtml(html, "/home/me/project/")).toBe(html);
	});

	it("takes a Windows path with either separator, in any case", () => {
		const html = `<img src="C:\\Users\\Me\\project\\shots\\a.png"><img src="file:///c:/users/me/project/b.png">`;

		expect(projectRelativeHtml(html, "C:\\Users\\Me\\project")).toBe(
			`<img src="shots\\a.png"><img src="b.png">`,
		);
	});
});
