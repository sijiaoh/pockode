// The device frames the raw captures are shown in (docs/marketing-assets.md
// §§2–3): a generic phone and a minimal browser window, as HTML for a page the
// stills renderer — or anything else that shows a framed capture — lays out.
// Each frame is drawn at its own size from its top-left corner; the caller
// places it and pads it.

// §2's screen, the bars the frame draws on it and the bezel around it; §3.1's
// page and the title bar above it.
const SCREEN = { width: 390, height: 844 };
const BEZEL = 12;
const STATUS_BAR = 24;
const HOME_STRIP = 16;
const ADDRESS_BAR = 44;
const PAGE = { width: 1440, height: 900 };
const TITLE_BAR = 40;

/**
 * The phone's body (§2), less the 48px of transparent room for its shadow.
 * `viewport` is the capture the screen shows (harness.mjs `VIEWPORTS`): the
 * screen less the bars, the address bar too for a browser tab. `screen` is
 * where that capture's top-left sits within the body, for whatever has to
 * point at a spot of it.
 */
export const PHONE = {
	width: SCREEN.width + 2 * BEZEL,
	height: SCREEN.height + 2 * BEZEL,
	padding: 48,
	viewport: (address) =>
		`${SCREEN.width}x${SCREEN.height - STATUS_BAR - HOME_STRIP - (address ? ADDRESS_BAR : 0)}`,
	screen: (address) => ({
		x: BEZEL,
		y: BEZEL + STATUS_BAR + (address ? ADDRESS_BAR : 0),
	}),
};
/**
 * The browser window (§3.1), with the same room. Its capture is the desktop
 * at retina density, below the title bar.
 */
export const WINDOW = {
	width: PAGE.width,
	height: PAGE.height + TITLE_BAR,
	padding: 48,
	viewport: "desktop@2x",
	titleBar: TITLE_BAR,
};

const SHADOW = "0 30px 60px rgba(0,0,0,.45), 0 8px 16px rgba(0,0,0,.30)";
const ADDRESS_BAR_BG = "#f4f4f5";

export const FRAME_CSS = `
.phone { position: absolute; width: ${PHONE.width}px; height: ${PHONE.height}px; }
.phone-body {
	position: absolute; inset: 0; border-radius: 54px; background: #1c1f24;
	box-shadow: 0 0 0 1px #2a2e35, ${SHADOW};
}
.phone-body::after {
	content: ""; position: absolute; inset: 1px; border-radius: 53px;
	border: 1px solid rgba(255,255,255,.08);
}
.phone-button { position: absolute; left: ${PHONE.width}px; width: 3px; border-radius: 1.5px; background: #2a2e35; }
.phone-camera {
	position: absolute; left: 204px; top: 3px; width: 6px; height: 6px;
	border-radius: 50%; background: #0b0d10; box-shadow: 0 0 0 1px #2a2e35;
}
.phone-screen {
	position: absolute; left: ${BEZEL}px; top: ${BEZEL}px; width: ${SCREEN.width}px; height: ${SCREEN.height}px;
	border-radius: 42px; overflow: hidden; display: flex; flex-direction: column;
}
.phone-screen > img { display: block; width: ${SCREEN.width}px; }
.phone-status {
	flex: none; height: ${STATUS_BAR}px; position: relative;
	font: 600 13px/${STATUS_BAR}px Geist; color: var(--fg);
}
.phone-status > span { position: absolute; left: 24px; top: 0; }
.phone-status > svg { position: absolute; right: 24px; top: 6.5px; }
.phone-home { flex: none; height: ${HOME_STRIP}px; display: flex; align-items: center; justify-content: center; }
.phone-home > div { width: 120px; height: 4px; border-radius: 2px; background: var(--fg); opacity: .6; }
.phone-address {
	flex: none; height: ${ADDRESS_BAR}px; background: ${ADDRESS_BAR_BG};
	display: flex; align-items: center; justify-content: center;
}
.phone-address > div {
	width: 358px; height: 32px; border-radius: 16px; background: #e4e4e7;
	display: flex; align-items: center; justify-content: center; gap: 6px;
	font: 400 13px Geist; color: #3f3f46;
}

.window {
	position: absolute; width: ${WINDOW.width}px; height: ${WINDOW.height}px; border-radius: 12px;
	background: #16191e; box-shadow: 0 0 0 1px #2a2e35, ${SHADOW}; overflow: hidden;
}
.window-title { height: ${TITLE_BAR}px; display: flex; align-items: center; justify-content: center; }
.window-title > div {
	width: 420px; height: 26px; border-radius: 13px; background: #0c0e12;
	display: flex; align-items: center; justify-content: center;
	font: 400 13px "Geist Mono"; color: #8a93a0;
}
.window > img { display: block; width: ${PAGE.width}px; height: ${PAGE.height}px; }
`;

// Signal, wi-fi and battery, 6 apart, in one 67.5×11 box whose right edge is
// the status bar's x 366.
const STATUS_ICONS = `<svg width="67.5" height="11" viewBox="0 0 67.5 11" fill="none">
	<g fill="currentColor">
		<rect x="0" y="7" width="3" height="4" /><rect x="4.5" y="5" width="3" height="6" />
		<rect x="9" y="3" width="3" height="8" /><rect x="13.5" y="1" width="3" height="10" />
	</g>
	<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round" transform="translate(29.7 10.4)">
		${[3, 6, 9]
			.map((r) => {
				const d = (r * Math.SQRT1_2).toFixed(3);
				return `<path d="M-${d} -${d} A${r} ${r} 0 0 1 ${d} -${d}" />`;
			})
			.join("")}
	</g>
	<g transform="translate(43 0)">
		<rect x="0.6" y="0.6" width="20.8" height="9.8" rx="2.4" stroke="currentColor" stroke-width="1.2" />
		<rect x="2" y="2" width="14.4" height="7" rx="1" fill="currentColor" />
		<rect x="23" y="3.5" width="1.5" height="4" rx="0.75" fill="currentColor" />
	</g>
</svg>`;

const LOCK = `<svg width="10" height="12" viewBox="0 0 10 12" fill="none" stroke="#52525b" stroke-width="1.4">
	<rect x="0.7" y="5.2" width="8.6" height="6.1" rx="1.4" /><path d="M2.6 5.2V3.6a2.4 2.4 0 0 1 4.8 0v1.6" />
</svg>`;

/** WCAG relative luminance of an sRGB colour given as [r, g, b] in 0–255. */
function luminance(rgb) {
	const [r, g, b] = rgb.map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A strip's background and the glyph colour that reads on it (§2). */
function strip(rgb) {
	const fg = luminance(rgb) <= 0.5 ? "#e8f0f5" : "#18181b";
	return `background: rgb(${rgb.join(",")}); --fg: ${fg};`;
}

/**
 * The colours at the top and bottom middle of a capture (x 195 of 390, first
 * and last row): the status bar and home strip continue them, so the frame
 * never draws a seam across the app's header or bottom bar. Run in the page
 * that will show it, which has to be able to load `src`.
 */
export function sampleEdges(page, src) {
	return page.evaluate(async (src) => {
		const img = new Image();
		img.src = src;
		await img.decode();
		const canvas = document.createElement("canvas");
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext("2d");
		ctx.drawImage(img, 0, 0);
		const x = Math.floor(img.naturalWidth / 2);
		const at = (y) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
		return { top: at(0), bottom: at(img.naturalHeight - 1) };
	}, src);
}

/**
 * The phone around a 390-wide capture. `edges` is what `sampleEdges` read from
 * it; `address` puts a browser's address bar showing that host between the
 * status bar and the capture (§3.2), for a page that is a browser tab by
 * nature — the capture is then the 760 tall the bar leaves.
 */
export function phoneFrame({
	src,
	edges,
	address,
	left = 0,
	top = 0,
	style = "",
}) {
	const statusBg = address
		? ADDRESS_BAR_BG.match(/\w\w/g).map((h) => Number.parseInt(h, 16))
		: edges.top;
	return `<div class="phone" style="left: ${left}px; top: ${top}px; ${style}">
	<div class="phone-button" style="top: 156px; height: 72px"></div>
	<div class="phone-button" style="top: 252px; height: 48px"></div>
	<div class="phone-body"></div>
	<div class="phone-camera"></div>
	<div class="phone-screen">
		<div class="phone-status" style="${strip(statusBg)}"><span>10:24</span>${STATUS_ICONS}</div>
		${address ? `<div class="phone-address"><div>${LOCK}${address}</div></div>` : ""}
		<img src="${src}" />
		<div class="phone-home" style="${strip(edges.bottom)}"><div></div></div>
	</div>
</div>`;
}

/** The browser window around a 1440×900 capture, at localhost (§3.1). */
export function windowFrame({ src, left = 0, top = 0 }) {
	return `<div class="window" style="left: ${left}px; top: ${top}px">
	<div class="window-title"><div>localhost:9870</div></div>
	<img src="${src}" />
</div>`;
}
