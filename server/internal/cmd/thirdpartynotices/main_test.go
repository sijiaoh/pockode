package main

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const mitText = `Copyright (c) 2020 Someone

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

// Fails here rather than at release time when a dependency is added whose
// license cannot be identified, on any platform the release builds: go list
// needs no cross-compiler, so a module linked only on linux/arm64 is caught on
// a pull request that no other workflow cross-builds.
func TestEveryLinkedModuleIsLicensed(t *testing.T) {
	// go list reads go.mod in a child process, which the test cache does not
	// see; reading them here makes a changed requirement re-run the test
	// rather than replay an earlier pass.
	for _, name := range []string{"../../../go.mod", "../../../go.sum"} {
		if _, err := os.ReadFile(name); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	if err := run(&out, releasePlatforms(t)); err != nil {
		t.Fatal(err)
	}
}

// The platforms array of scripts/build.sh, the one list of what a release
// builds.
func releasePlatforms(t *testing.T) []string {
	t.Helper()
	script, err := os.ReadFile("../../../../scripts/build.sh")
	if err != nil {
		t.Fatal(err)
	}
	array := regexp.MustCompile(`(?m)^\s*platforms=\(\n((?:\s*"[^"]+"\n)+)\s*\)`).FindSubmatch(script)
	if array == nil {
		t.Fatal(`scripts/build.sh has no multi-line platforms=( "GOOS/GOARCH" ... ) array`)
	}
	var platforms []string
	for _, m := range regexp.MustCompile(`"([^"]+)"`).FindAllSubmatch(array[1], -1) {
		platforms = append(platforms, string(m[1]))
	}
	return platforms
}

func TestUnrecognizedLicenseNamesTheModule(t *testing.T) {
	e := entry{Name: "example.com/m", Version: "v1.0.0", Files: []file{
		{Name: "LICENSE", Text: "All rights reserved. Ask us before using this."},
	}}
	err := identifyLicenses(&e)
	if err == nil || !strings.Contains(err.Error(), "example.com/m v1.0.0") {
		t.Fatalf("err = %v, want one naming the module", err)
	}
}

func TestCompanionFileAloneIsNoLicense(t *testing.T) {
	e := entry{Name: "example.com/m", Version: "v1.0.0", Files: []file{{Name: "NOTICE", Text: mitText}}}
	if err := identifyLicenses(&e); err == nil {
		t.Fatal("a module with only a NOTICE passed")
	}
}

func TestModuleLicenseFiles(t *testing.T) {
	write := func(path, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("nearest license wins", func(t *testing.T) {
		mod := t.TempDir()
		write(filepath.Join(mod, "LICENSE"), mitText)
		write(filepath.Join(mod, "NOTICE"), "notice")
		write(filepath.Join(mod, "sub", "a.go"), "package sub")
		write(filepath.Join(mod, "third_party", "x", "LICENSE.txt"), mitText)
		write(filepath.Join(mod, "third_party", "x", "y", "b.go"), "package y")
		files, err := moduleLicenseFiles(mod, map[string]bool{
			mod:                       true,
			filepath.Join(mod, "sub"): true,
			filepath.Join(mod, "third_party", "x", "y"): true,
		})
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, f := range files {
			names = append(names, f.Name)
		}
		if got, want := strings.Join(names, " "), "LICENSE NOTICE third_party/x/LICENSE.txt"; got != want {
			t.Errorf("files = %q, want %q", got, want)
		}
	})

	t.Run("no license is an error", func(t *testing.T) {
		mod := t.TempDir()
		write(filepath.Join(mod, "NOTICE"), "notice")
		if _, err := moduleLicenseFiles(mod, map[string]bool{mod: true}); err == nil {
			t.Fatal("a module without a license file passed")
		}
	})
}
