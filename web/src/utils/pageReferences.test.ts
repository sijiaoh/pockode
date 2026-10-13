import { describe, expect, it } from "vitest";
import { hasRelativeReferences } from "./pageReferences";

describe("hasRelativeReferences", () => {
	it.each([
		['<script src="app.js"></script>'],
		['<link rel="stylesheet" href="css/style.css">'],
		['<img srcset="https://cdn.example/a.png 1x, img/b.png 2x">'],
		['<video><source src="clip.mp4"></video>'],
		['<object data="chart.svg"></object>'],
		['<a href="other.html">next</a>'],
		["<style>body { background: url('bg.png') }</style>"],
		['<style>@import "theme.css";</style>'],
		['<div style="background: url(bg.png)"></div>'],
		['<base href="sub/"><img src="a.png">'],
		['<img src="../shared/logo.png">'],
		['<IMG SRC="Logo.PNG">'],
		["<svg><style>rect { fill: url(p.png) }</style></svg>"],
		[`<div style='background: image-set("a.png" 1x, "a@2x.png" 2x)'></div>`],
		['<video poster="poster.jpg"></video>'],
		['<svg><use xlink:href="sprite.svg#icon"></use></svg>'],
		['<svg><image href="figure.png"></image></svg>'],
		['<template><img src="later.png"></template>'],
		['<img srcset="data:image/png;base64,AA 1x, img/b.png 2x">'],
	])("finds one in %s", (html) => {
		expect(hasRelativeReferences(html)).toBe(true);
	});

	it.each([
		["<p>No links at all</p>"],
		['<img src="">'],
		['<a href="#section">jump</a>'],
		['<script src="https://cdn.example/lib.js"></script>'],
		['<link href="//fonts.example/css">'],
		['<a href="/elsewhere">root</a>'],
		['<img src="data:image/png;base64,AA==">'],
		['<img src="blob:https://x/1">'],
		['<a href="mailto:a@example.com">mail</a>'],
		['<a href="javascript:void(0)">js</a>'],
		["<style>body { background: url(data:image/png;base64,AA==) }</style>"],
		['<base href="https://example.com/"><img src="a.png">'],
		['<base href="/"><img src="a.png">'],
		['<img srcset="data:image/png;base64,AA 1x">'],
		['<img src="ht\ntps://cdn.example/a.png">'],
		['<img src="\\\\cdn.example/a.png">'],
		['<p>Hi</p><noscript><img src="tracker.png"></noscript>'],
		// Text, not a reference.
		['<p>see style.css</p><pre>&lt;img src="a.png"&gt;</pre>'],
	])("finds none in %s", (html) => {
		expect(hasRelativeReferences(html)).toBe(false);
	});
});
