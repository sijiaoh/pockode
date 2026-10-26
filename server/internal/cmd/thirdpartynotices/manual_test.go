package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A re-port that moves to another fzf release, or picks up a new copyright
// year, changes the headers; the notice has to follow.
func TestFzfEntryMatchesPortedHeaders(t *testing.T) {
	paths, err := filepath.Glob("../../../fuzzy/*.go")
	if err != nil {
		t.Fatal(err)
	}
	ported := 0
	for _, path := range paths {
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(string(src), "// This file is ported from fzf ") {
			continue
		}
		ported++
		name := filepath.Base(path)
		if !strings.HasPrefix(string(src), "// This file is ported from fzf "+fzfEntry.Version) {
			t.Errorf("%s is ported from another fzf version than %s", name, fzfEntry.Version)
		}
		if !strings.Contains(headerText(string(src)), fzfLicense) {
			t.Errorf("%s does not carry fzfLicense in its header", name)
		}
	}
	if ported == 0 {
		t.Fatal("no file in server/fuzzy says it is ported from fzf")
	}
}

func headerText(src string) string {
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if !strings.HasPrefix(line, "//") {
			break
		}
		line = strings.TrimPrefix(strings.TrimPrefix(line, "//"), " ")
		b.WriteString(line + "\n")
	}
	return b.String()
}
