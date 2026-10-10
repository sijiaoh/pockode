// The 1200×630 social image (docs/marketing-assets.md §5): the pitch on the
// left, the phone answering task 3's question on the right, bleeding off the
// bottom edge.

import { PHONE, phoneFrame } from "./frames.mjs";

export const SOCIAL = { width: 1200, height: 630 };

// Where the footer's baseline sits. CSS places a box, not a baseline, so the
// page measures how far below its box the baseline falls and moves the box.
const FOOTER_BASELINE = 558;

export function socialPage({ logo, phone }) {
	return {
		css: `
body { width: 1200px; height: 630px; background: #0a0a0a; position: relative; overflow: hidden; }
.glow {
	position: absolute; inset: 0;
	background: radial-gradient(ellipse at 900px 0, rgba(59,130,246,.12) 0%, rgba(168,85,247,.06) 40%, transparent 70%);
}
.logo { position: absolute; left: 72px; top: 72px; width: 56px; height: 56px; }
.wordmark {
	position: absolute; left: 144px; top: 72px; height: 56px; display: flex; align-items: center;
	font: 700 32px Geist; letter-spacing: -0.02em; color: #fafafa;
}
.pitch { position: absolute; left: 72px; top: 196px; }
h1 {
	margin: 0; width: 560px; font: 700 76px/1.02 Geist; letter-spacing: -0.04em;
	background: linear-gradient(135deg, #fff 0%, #fff 50%, #60a5fa 100%);
	-webkit-background-clip: text; background-clip: text; color: transparent;
}
.pitch p { margin: 32px 0 0; width: 520px; font: 400 24px/1.45 Geist; color: #a1a1a1; }
.footer { position: absolute; left: 72px; font: 500 20px Geist; color: #666666; }
.footer i { display: inline-block; }`,
		body: `
<div class="glow"></div>
<img class="logo" src="${logo}" />
<div class="wordmark">Pockode</div>
<div class="pitch">
	<h1>Code from<br />your pocket</h1>
	<p>Talk to Claude Code and Codex from your phone. Your code stays on your machine.</p>
</div>
<div class="footer">pockode.com · Open source<i></i></div>
${phoneFrame({
	...phone,
	left: 760,
	top: 72,
	style: `transform: scale(${640 / PHONE.height}); transform-origin: 0 0;`,
})}
<script>
	window.layout = () => {
		const footer = document.querySelector(".footer");
		const below = footer.querySelector("i").getBoundingClientRect().top - footer.getBoundingClientRect().top;
		footer.style.top = ${FOOTER_BASELINE} - below + "px";
	};
</script>`,
	};
}
