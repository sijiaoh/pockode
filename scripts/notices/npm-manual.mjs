// What shipped npm packages fail to publish themselves: `license`, for one
// whose package.json declares none, and `text`, for one that carries no
// LICENSE file. Each entry is keyed by the exact `name@version`, so an upgrade
// fails the generator until someone checks whether the new version fixed it;
// an entry no shipped package uses fails it too.
//
// `source` says where the filled-in value was read from; for a `text` it is
// printed in the notices beside it, after "from".
//
// A package bundled into a shipped one but not installed (a source map names
// it; see npm.mjs) has nothing to read at all, so its entry carries both
// `license` and `text`. It is keyed by `name@version` when the map's path
// records the version, and otherwise by `name (bundled in owner@version)`.

const MIT = (copyright) => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export const MANUAL = {
	"format@0.2.2": {
		source:
			"the License section of the package's Readme.md and the MIT License it links to",
		text: MIT("Copyright 2010 - 2014 Sami Samhuri sami@samhuri.net"),
	},
	"path-browserify (bundled in mermaid@11.12.2)": {
		source:
			"the LICENSE of path-browserify 1.0.1 on npm, the release vscode-uri, which Mermaid bundles, builds it in from",
		license: "MIT",
		text: MIT("Copyright (c) 2013 James Halliday"),
	},
	"style-inject (bundled in react-zoom-pan-pinch@4.2.0)": {
		source: "the LICENSE of style-inject 0.3.0, its latest release, on npm",
		license: "MIT",
		text: MIT("Copyright (c) 2015 egoist 0x142857@gmail.com"),
	},
	"khroma@2.1.0": {
		source: "the package's own license file, which is the MIT License",
		license: "MIT",
	},
	"use-composed-ref@1.4.0": {
		source:
			"the MIT License it declares; no copyright line is published anywhere (package, repository, npm), so the holder is the owner of github.com/Andarist/use-composed-ref",
		text: MIT("Copyright (c) Mateusz Burzyński"),
	},
};

// Shipped packages whose content is built from a package they only list as a
// devDependency, so neither the bundle nor a source map shows it: Shiki's
// grammars and themes are generated from these two, whose NOTICE files carry
// each grammar's and theme's upstream license. The source package has to be
// installed — it is a root devDependency, in the range the shipped package
// declares — for its license files to be read.
export const CONTENT_FROM = {
	"@shikijs/langs": "tm-grammars",
	"@shikijs/themes": "tm-themes",
};
