package main

// Third-party code compiled into the server that no module brings in, so go
// list cannot see it. Porting more code, or re-porting from a newer release,
// means updating this list by hand; manual_test.go checks the fzf entry
// against the headers of the ported files.
var manualEntries = []entry{fzfEntry}

var fzfEntry = entry{
	Name:    "fzf (ported into server/fuzzy)",
	Version: "v0.74.5",
	URL:     "https://github.com/junegunn/fzf",
	Files:   []file{{Name: "LICENSE", Text: fzfLicense}},
}

// From the header of every file in server/fuzzy that was ported from fzf.
const fzfLicense = `The MIT License (MIT)

Copyright (c) 2013-2026 Junegunn Choi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`
