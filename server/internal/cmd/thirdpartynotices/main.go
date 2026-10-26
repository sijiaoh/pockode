// Prints the third-party notices for the server binary: the license text of
// every module and of the Go standard library that `go list` says the binary
// links for the given platforms, followed by the hand-kept entries in
// manual.go. It exits non-zero, printing nothing to stdout, if any of them has
// no license it can identify, so a release cannot ship an incomplete file.
//
// Run it from server/ with the platforms scripts/build.sh builds:
//
//	go run ./internal/cmd/thirdpartynotices linux/amd64 darwin/arm64 > NOTICES
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/google/licensecheck"
)

// The package scripts/build.sh builds into the binary.
const serverPackage = "github.com/pockode/server"

// Below this share of a license file matched by known license texts, the file
// is not trusted to be what licensecheck names it: it may add terms of its own,
// or be a license licensecheck does not know. Prose saying which files fall
// under which license is legitimate and costs gopkg.in/yaml.v3 15%.
const minCoverage = 75

var (
	licenseFileName = regexp.MustCompile(`(?i)^(licen[cs]e|copying)([._-].*)?$`)
	// Files beside a license that carry obligations of their own, such as the
	// NOTICE file Apache-2.0 requires to be passed on.
	companionFileName = regexp.MustCompile(`(?i)^(notice|patents)([._-].*)?$`)
)

type entry struct {
	Name    string
	Version string
	URL     string
	Files   []file
	// SPDX IDs found in Files, filled in by identifyLicenses.
	Licenses []string
}

type file struct {
	Name string
	Text string
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: thirdpartynotices GOOS/GOARCH...")
		os.Exit(2)
	}
	var out bytes.Buffer
	if err := run(&out, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "thirdpartynotices:", err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(out.Bytes()); err != nil {
		fmt.Fprintln(os.Stderr, "thirdpartynotices:", err)
		os.Exit(1)
	}
}

func run(w io.Writer, platforms []string) error {
	entries, err := linkedEntries(platforms)
	errs := []error{err}
	entries = append(entries, manualEntries...)
	for i := range entries {
		if err := identifyLicenses(&entries[i]); err != nil {
			errs = append(errs, err)
		}
	}
	if err := errors.Join(errs...); err != nil {
		return err
	}
	render(w, entries)
	return nil
}

type listedPackage struct {
	Dir      string
	Standard bool
	Module   *listedModule
}

type listedModule struct {
	Path    string
	Version string
	Dir     string
	Main    bool
	Replace *listedModule
}

// linkedEntries returns the Go toolchain first, then one entry per module in
// path order. A module without a license file is reported, together with every
// other one, as the error.
func linkedEntries(platforms []string) ([]entry, error) {
	modules := map[string]entry{}
	moduleDirs := map[string]string{}
	packageDirs := map[string]map[string]bool{}
	for _, platform := range platforms {
		goos, goarch, ok := strings.Cut(platform, "/")
		if !ok || goos == "" || goarch == "" {
			return nil, fmt.Errorf("platform %q is not GOOS/GOARCH", platform)
		}
		pkgs, err := listDeps(goos, goarch)
		if err != nil {
			return nil, err
		}
		for _, p := range pkgs {
			if p.Standard || p.Module == nil || p.Module.Main {
				continue
			}
			m := p.Module
			e := entry{
				Name:    m.Path,
				Version: m.Version,
				URL:     "https://pkg.go.dev/" + m.Path + "@" + m.Version,
			}
			dir := m.Dir
			// A replaced module's code, and so its license, comes from the
			// replacement; it keeps the name it is required by.
			if r := m.Replace; r != nil {
				dir = r.Dir
				e.Version += " => " + strings.TrimSpace(r.Path+" "+r.Version)
			}
			if dir == "" {
				return nil, fmt.Errorf("module %s %s has no directory; run go mod download", e.Name, e.Version)
			}
			key := e.Name + "@" + e.Version
			modules[key] = e
			moduleDirs[key] = dir
			if packageDirs[key] == nil {
				packageDirs[key] = map[string]bool{}
			}
			packageDirs[key][p.Dir] = true
		}
	}

	goEntry, err := goToolchainEntry()
	if err != nil {
		return nil, err
	}
	entries := []entry{goEntry}
	keys := make([]string, 0, len(modules))
	for k := range modules {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var errs []error
	for _, k := range keys {
		e := modules[k]
		files, err := moduleLicenseFiles(moduleDirs[k], packageDirs[k])
		if err != nil {
			errs = append(errs, fmt.Errorf("module %s %s: %w", e.Name, e.Version, err))
			continue
		}
		e.Files = files
		entries = append(entries, e)
	}
	return entries, errors.Join(errs...)
}

func listDeps(goos, goarch string) ([]listedPackage, error) {
	cmd := exec.Command("go", "list", "-deps", "-json=Dir,Standard,Module", serverPackage)
	// CGO_ENABLED=0 as in scripts/build.sh: cgo changes which files, and so
	// which imports, a package builds with.
	cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch, "CGO_ENABLED=0")
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list for %s/%s: %w", goos, goarch, err)
	}
	var pkgs []listedPackage
	dec := json.NewDecoder(bytes.NewReader(out))
	for {
		var p listedPackage
		if err := dec.Decode(&p); err == io.EOF {
			break
		} else if err != nil {
			return nil, fmt.Errorf("go list for %s/%s: %w", goos, goarch, err)
		}
		pkgs = append(pkgs, p)
	}
	return pkgs, nil
}

// The runtime and standard library are linked into every Go binary, under the
// license of the toolchain that builds it.
func goToolchainEntry() (entry, error) {
	out, err := exec.Command("go", "env", "GOROOT", "GOVERSION").Output()
	if err != nil {
		return entry{}, fmt.Errorf("go env: %w", err)
	}
	goroot, version, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	files, err := licenseFilesIn(goroot)
	if err != nil {
		return entry{}, fmt.Errorf("Go toolchain at %s: %w", goroot, err)
	}
	return entry{
		Name:    "The Go Programming Language (runtime and standard library)",
		Version: version,
		URL:     "https://go.dev/LICENSE",
		Files:   files,
	}, nil
}

// moduleLicenseFiles finds, for each package the binary links from a module,
// the license nearest to it on the way up to the module root, the way a
// license in a subdirectory overrides the root one for the code below it.
func moduleLicenseFiles(moduleDir string, packageDirs map[string]bool) ([]file, error) {
	dirs := make([]string, 0, len(packageDirs))
	for d := range packageDirs {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)
	seen := map[string]bool{}
	var files []file
	for _, d := range dirs {
		licenseDir, found, err := nearestLicenseDir(moduleDir, d)
		if err != nil {
			return nil, err
		}
		if !found {
			rel, _ := filepath.Rel(moduleDir, d)
			return nil, fmt.Errorf("no license file in package directory %s or above it", filepath.ToSlash(rel))
		}
		if seen[licenseDir] {
			continue
		}
		seen[licenseDir] = true
		fs, err := licenseFilesIn(licenseDir)
		if err != nil {
			return nil, err
		}
		if licenseDir != moduleDir {
			rel, _ := filepath.Rel(moduleDir, licenseDir)
			for i := range fs {
				fs[i].Name = filepath.ToSlash(filepath.Join(rel, fs[i].Name))
			}
		}
		files = append(files, fs...)
	}
	return files, nil
}

func nearestLicenseDir(moduleDir, dir string) (string, bool, error) {
	for {
		fs, err := licenseFilesIn(dir)
		if err != nil {
			return "", false, err
		}
		if len(fs) > 0 {
			return dir, true, nil
		}
		if dir == moduleDir {
			return "", false, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false, nil
		}
		dir = parent
	}
}

// licenseFilesIn returns the license files of dir followed by their
// companions, or nothing if dir has no license file.
func licenseFilesIn(dir string) ([]file, error) {
	dirEntries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var licenses, companions []file
	for _, de := range dirEntries {
		name := de.Name()
		if de.IsDir() || strings.HasSuffix(name, ".go") {
			continue
		}
		isLicense := licenseFileName.MatchString(name)
		if !isLicense && !companionFileName.MatchString(name) {
			continue
		}
		text, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		f := file{Name: name, Text: string(text)}
		if isLicense {
			licenses = append(licenses, f)
		} else {
			companions = append(companions, f)
		}
	}
	if len(licenses) == 0 {
		return nil, nil
	}
	return append(licenses, companions...), nil
}

// identifyLicenses requires every license file of e to be identified, and
// there to be at least one. Companion files are passed on as they are.
func identifyLicenses(e *entry) error {
	seen := map[string]bool{}
	for _, f := range e.Files {
		if !licenseFileName.MatchString(filepath.Base(f.Name)) {
			continue
		}
		ids, err := identify(f.Text)
		if err != nil {
			return fmt.Errorf("%s %s: %s: %w", e.Name, e.Version, f.Name, err)
		}
		for _, id := range ids {
			if !seen[id] {
				seen[id] = true
				e.Licenses = append(e.Licenses, id)
			}
		}
	}
	if len(e.Licenses) == 0 {
		return fmt.Errorf("%s %s: no license file", e.Name, e.Version)
	}
	return nil
}

// identify returns the SPDX IDs of the licenses in text, in the order they
// appear.
func identify(text string) ([]string, error) {
	cov := licensecheck.Scan([]byte(text))
	if len(cov.Match) == 0 {
		return nil, errors.New("license not recognized")
	}
	if cov.Percent < minCoverage {
		return nil, fmt.Errorf("license only %.0f%% recognized (as %s), below %d%%", cov.Percent, cov.Match[0].ID, minCoverage)
	}
	ids := make([]string, 0, len(cov.Match))
	for _, m := range cov.Match {
		ids = append(ids, m.ID)
	}
	return ids, nil
}

const (
	entryRule = "================================================================================"
	fileRule  = "--------------------------------------------------------------------------------"
)

func render(w io.Writer, entries []entry) {
	fmt.Fprintln(w, "Pockode server: third-party software")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "The Pockode server binary includes the following third-party software,")
	fmt.Fprintln(w, "distributed under the licenses reproduced below. Each entry links to the")
	fmt.Fprintln(w, "page its source code can be obtained from.")
	for _, e := range entries {
		fmt.Fprintln(w)
		fmt.Fprintln(w, entryRule)
		fmt.Fprintf(w, "%s %s\n", e.Name, e.Version)
		fmt.Fprintln(w, e.URL)
		fmt.Fprintf(w, "License: %s\n", strings.Join(e.Licenses, ", "))
		for _, f := range e.Files {
			fmt.Fprintln(w, fileRule)
			fmt.Fprintln(w, f.Name)
			fmt.Fprintln(w)
			fmt.Fprintln(w, strings.TrimRight(f.Text, "\n"))
		}
	}
}
