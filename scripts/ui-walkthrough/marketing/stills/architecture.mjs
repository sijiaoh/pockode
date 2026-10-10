// The architecture figure (docs/marketing-assets.md §6), on a transparent
// background: phone → relay ← PC → AI CLIs, the PC and the CLIs inside
// "Your machine". Landscape in a dark and a light variant for a <picture>,
// and a portrait one (§6.1) in dark for the site's narrow screens.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LOGO_STOPS } from "../palette.mjs";

// The dark variant is the site's, in its tokens, bar the boundary: dashed
// and decorative, it would all but vanish in `--border`. The site has no
// light palette, so the light variant is the figure's own, and keeps the
// logo's stops, which hold up on white where the site's lighter ones do not.
const THEMES = {
	dark: {
		card: "var(--card)",
		stroke: "var(--border)",
		title: "var(--text)",
		small: "var(--text-2)",
		lock: "var(--text)",
		boundary: "#3f3f46",
		brand: ["var(--brand-1)", "var(--brand-2)"],
	},
	light: {
		card: "#ffffff",
		stroke: "#e4e4e7",
		title: "#18181b",
		small: "#52525b",
		lock: "#18181b",
		boundary: "#a1a1aa",
		brand: LOGO_STOPS,
	},
};

const NODES = {
	phone: { icon: "smartphone", title: "Your phone", sub: "any browser" },
	relay: { icon: "cloud", title: "Relay", sub: "cloud.pockode.com" },
	pc: { icon: "laptop", title: "Your PC", sub: "pockode" },
	cli: { icon: "terminal", title: "claude · codex", sub: "AI CLIs" },
};
const EDGES = [
	{ from: "phone", to: "relay", label: "HTTPS / WSS", lock: true },
	// At the relay: the PC dials out, which is why it opens no port.
	{ from: "pc", to: "relay", label: "outbound tunnel", lock: true },
	{ from: "pc", to: "cli", label: "spawns · stream-json" },
];
// Room between a card and the edge's end, and between the line and its lock.
const CLEARANCE = 6;
const ARROW = 8;
const LOCK = { width: 12, height: 14 };

/** The app's own icon set, at the version the app pins (web's lucide-react). */
async function icon(name, projectDir) {
	const { __iconNode } = await import(
		pathToFileURL(
			join(
				projectDir,
				`web/node_modules/lucide-react/dist/esm/icons/${name}.js`,
			),
		).href
	);
	return __iconNode
		.map(
			([tag, attrs]) =>
				`<${tag} ${Object.entries(attrs)
					.filter(([k]) => k !== "key")
					.map(([k, v]) => `${k}="${v}"`)
					.join(" ")} />`,
		)
		.join("");
}

const cards = (projectDir, size, style) =>
	Promise.all(
		Object.entries(NODES).map(
			async ([name, node]) => `
<div class="card" style="${style(name)}">
	<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="url(#brand)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${await icon(node.icon, projectDir)}</svg>
	<div class="title">${node.title}</div>
	<div class="sub">${node.sub}</div>
</div>`,
		),
	);

// Through `style`, not the attributes: a presentation attribute takes no var().
const stops = ({ brand: [from, to] }) =>
	`<stop offset="0" style="stop-color: ${from}" /><stop offset="1" style="stop-color: ${to}" />`;

const brand = (theme) => `
	<defs>
		<linearGradient id="brand" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
			${stops(theme)}
		</linearGradient>
	</defs>`;

const boundary = ({ left, right, top, bottom }, theme) => `
	<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="18"
		fill="none" stroke="${theme.boundary}" stroke-width="1.5" stroke-dasharray="6 4" />`;

/**
 * A straight edge running along `axis` ("x" or "y") at `at` across it, from
 * `tail` to the arrow's `tip`, broken around a lock centred at `lock` if any.
 */
function line({ axis, at, tail, tip, lock }, id, theme) {
	const xy = (along, across) =>
		axis === "x" ? [along, across] : [across, along];
	const dir = tip > tail ? -1 : 1;
	const base = tip + dir * ARROW;
	// The line runs to the arrow's base, and around the lock with room either side.
	const [lo, hi] = [Math.min(tail, base), Math.max(tail, base)];
	const gap = (axis === "x" ? LOCK.width : LOCK.height) / 2 + CLEARANCE;
	const segments =
		lock === undefined
			? [[lo, hi]]
			: [
					[lo, lock - gap],
					[lock + gap, hi],
				].filter(([a, b]) => b > a);
	const [from, to] = [Math.min(tail, tip), Math.max(tail, tip)];
	const [gx1, gy1] = xy(from, 0);
	const [gx2, gy2] = xy(to, 0);
	const [tipX, tipY] = xy(tip, at);
	const [b1x, b1y] = xy(base, at - ARROW / 2);
	const [b2x, b2y] = xy(base, at + ARROW / 2);
	return `
	<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${gx1}" y1="${gy1}" x2="${gx2}" y2="${gy2}">
		${stops(theme)}
	</linearGradient>
	${segments
		.map(([a, b]) => {
			const [x1, y1] = xy(a, at);
			const [x2, y2] = xy(b, at);
			return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="url(#${id})" stroke-width="2" />`;
		})
		.join("")}
	<path d="M${tipX} ${tipY} L${b1x} ${b1y} L${b2x} ${b2y} Z" fill="url(#${id})" />
	${lock === undefined ? "" : lockIcon(...xy(lock, at), theme)}`;
}

/** The padlock, centred on (x, y). */
const lockIcon = (x, y, theme) =>
	`<g transform="translate(${x - LOCK.width / 2} ${y - LOCK.height / 2})" style="fill: ${theme.lock}">
		<path d="M3 6.5V4a3 3 0 0 1 6 0v2.5" style="fill: none; stroke: ${theme.lock}" stroke-width="1.5" />
		<rect x="0" y="6" width="12" height="8" rx="2" />
	</g>`;

// §6: the nodes in a row.
const LANDSCAPE = {
	size: { width: 1220, height: 360 },
	card: { width: 168, height: 128, top: 116 },
	x: { phone: 24, relay: 328, pc: 656, cli: 1008 },
	boundary: { left: 636, right: 1196, top: 60, bottom: 300 },
};

async function landscapePage(theme, projectDir) {
	const { card, x } = LANDSCAPE;
	const midY = card.top + card.height / 2;
	const edges = EDGES.map(({ from, to, label, lock }, i) => {
		const left = Math.min(x[from], x[to]) + card.width + CLEARANCE;
		const right = Math.max(x[from], x[to]) - CLEARANCE;
		const mid = (left + right) / 2;
		const [tail, tip] = x[to] > x[from] ? [left, right] : [right, left];
		return `${line({ axis: "x", at: midY, tail, tip, lock: lock ? mid : undefined }, `edge-${i}`, theme)}
	<text x="${mid}" y="${midY - 10}" text-anchor="middle" class="label">${label}</text>`;
	});
	const { left, right, top, bottom } = LANDSCAPE.boundary;
	return {
		css: `
body { width: 1220px; height: 360px; position: relative; }
svg.edges { position: absolute; inset: 0; }
.label { font: 500 12px Geist; fill: ${theme.small}; }
.card {
	position: absolute; top: ${card.top}px; width: ${card.width}px; height: ${card.height}px;
	box-sizing: border-box; border: 1px solid ${theme.stroke}; border-radius: 14px; background: ${theme.card};
	display: flex; flex-direction: column; align-items: center; padding-top: 19px;
}
.title { margin-top: 16px; font: 600 17px Geist; color: ${theme.title}; }
.sub { margin-top: 4px; font: 400 12px "Geist Mono"; color: ${theme.small}; }
.machine {
	position: absolute; left: ${left}px; top: ${top}px; width: ${right - left}px; height: ${bottom - top}px;
	font-size: 12px; color: ${theme.small};
}
.machine > div:first-child {
	position: absolute; left: 14px; top: 12px;
	font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
}
.machine > div:last-child { position: absolute; left: 0; right: 0; bottom: 12px; text-align: center; }`,
		body: `
<svg class="edges" width="1220" height="360">${brand(theme)}${boundary(LANDSCAPE.boundary, theme)}
	${edges.join("")}
</svg>
<div class="machine"><div>Your machine</div><div>no open ports · code runs here</div></div>
${(await cards(projectDir, 32, (name) => `left: ${x[name]}px`)).join("")}`,
	};
}

// §6.1: the same figure stacked, for the site below 1024px. Its small text is
// 13px rather than 12: drawn at most 360 CSS px wide and down to a 343px
// column, it stays at 12px or above.
const PORTRAIT = {
	size: { width: 360, height: 800 },
	card: { width: 240, height: 88, left: 60 },
	top: { phone: 16, relay: 196, pc: 400, cli: 580 },
	edgeX: 180,
	// The midpoint would put the lock on the boundary's top edge.
	lock: { "pc-relay": 312 },
	labelX: 196,
	boundary: { left: 24, right: 336, top: 336, bottom: 784 },
	footnoteBaseline: 760,
};

async function portraitPage(theme, projectDir) {
	const { card, top, edgeX, labelX } = PORTRAIT;
	const edges = EDGES.map(({ from, to, label, lock }, i) => {
		const down = top[to] > top[from];
		const [tail, tip] = down
			? [top[from] + card.height + CLEARANCE, top[to] - CLEARANCE]
			: [top[from] - CLEARANCE, top[to] + card.height + CLEARANCE];
		const at = PORTRAIT.lock[`${from}-${to}`] ?? (tail + tip) / 2;
		return `${line({ axis: "y", at: edgeX, tail, tip, lock: lock ? at : undefined }, `edge-${i}`, theme)}
	<text x="${labelX}" y="${at}" dominant-baseline="central" class="label">${label}</text>`;
	});
	const { left, right, top: boxTop } = PORTRAIT.boundary;
	return {
		css: `
body { width: 360px; height: 800px; position: relative; }
svg.edges { position: absolute; inset: 0; }
.label { font: 500 13px Geist; fill: ${theme.small}; }
.card {
	position: absolute; left: ${card.left}px; width: ${card.width}px; height: ${card.height}px;
	box-sizing: border-box; border: 1px solid ${theme.stroke}; border-radius: 14px; background: ${theme.card};
	display: flex; flex-direction: column; justify-content: center; padding-left: 64px;
}
.card > svg { position: absolute; left: 20px; top: 30px; }
.title { font: 600 17px Geist; color: ${theme.title}; }
.sub { margin-top: 4px; font: 400 13px "Geist Mono"; color: ${theme.small}; }
.machine {
	position: absolute; left: ${left + 14}px; top: ${boxTop + 14}px;
	font: 600 13px Geist; text-transform: uppercase; letter-spacing: 0.06em; color: ${theme.small};
}
.footnote { font: 400 13px Geist; fill: ${theme.small}; }`,
		body: `
<svg class="edges" width="360" height="800">${brand(theme)}${boundary(PORTRAIT.boundary, theme)}
	${edges.join("")}
	<text x="${(left + right) / 2}" y="${PORTRAIT.footnoteBaseline}" text-anchor="middle" class="footnote">no open ports · code runs here</text>
</svg>
<div class="machine">Your machine</div>
${(await cards(projectDir, 28, (name) => `top: ${top[name]}px`)).join("")}`,
	};
}

/** Every figure, as `file` under the assets, its logical size and its page. */
export const ARCHITECTURE_FIGURES = [
	...Object.entries(THEMES).map(([variant, theme]) => ({
		file: `architecture-${variant}.png`,
		...LANDSCAPE.size,
		page: (projectDir) => landscapePage(theme, projectDir),
	})),
	{
		file: "architecture-dark-portrait.png",
		...PORTRAIT.size,
		page: (projectDir) => portraitPage(THEMES.dark, projectDir),
	},
];
