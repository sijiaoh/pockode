package wirets

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
)

// The module root, from this package's directory, which is where go test runs.
const moduleRoot = "../.."

// TestGeneratedFileIsCurrent fails when the checked-in TypeScript is not what
// the Go types produce now. After changing a wire type, regenerate with
// UPDATE_WIRE_TYPES=1 and type-check the web client: what stops compiling there
// is what the change asks of it.
//
// go test's cache does not watch the file, which is outside this module: a
// change to the Go side reruns this, a hand edit of the file alone needs
// -count=1 to be caught — which is how the Server workflow runs it.
func TestGeneratedFileIsCurrent(t *testing.T) {
	want, err := Generate(moduleRoot)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(moduleRoot, filepath.FromSlash(OutputPath))
	if os.Getenv("UPDATE_WIRE_TYPES") != "" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s is out of step with the Go wire types; regenerate it with\n\tcd server && UPDATE_WIRE_TYPES=1 go test ./agent/wirets\nand type-check the web client (cd web && pnpm exec tsc -b)", OutputPath)
	}
}

// The parts reflection alone would get wrong, checked on the output itself.
func TestGenerate(t *testing.T) {
	out, err := Generate(moduleRoot)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		// The discriminator, which is no struct field.
		"export interface TextRecord {\n\ttype: \"text\";\n",
		// An empty record is still its type.
		"export interface BackgroundWaitRecord {\n\ttype: \"background_wait\";\n}\n",
		// Embedded structs are flattened, as encoding/json writes them.
		"\tlast_tool_name?: string;\n",
		// A slice written without omitempty is `null` when nil.
		"\toptions: QuestionOption[] | null;\n",
		// A named string type is the union of its constants.
		"export type CancelReason =\n\t| \"process_ended\"\n",
		// Records and live events stay apart.
		"export type LiveEvent = ToolActivityLiveEvent | ThinkingDeltaLiveEvent;\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("output lacks %q", want)
		}
	}
	if strings.Contains(between(s, "export type HistoryRecord =", ";"), "LiveEvent") {
		t.Error("a live event is listed among the history records")
	}
}

func between(s, start, end string) string {
	_, after, _ := strings.Cut(s, start)
	before, _, _ := strings.Cut(after, end)
	return before
}

// What the derivation cannot describe fails instead of coming out as a guess.
func TestGenerateRefuses(t *testing.T) {
	type embedsMarshaler struct{ selfMarshaling }
	type fieldMarshaler struct {
		V selfMarshaling `json:"v"`
	}
	type pointerMarshaler struct {
		V pointerMarshaling `json:"v"`
	}
	type textMarshaler struct {
		V textMarshaling `json:"v"`
	}
	type byteMarshaler struct {
		V []byteMarshaling `json:"v"`
	}
	type withInterface struct {
		V any `json:"v"`
	}
	type withIntKey struct {
		M map[int]string `json:"m"`
	}
	type withOption struct {
		S string `json:"s,string"`
	}
	type twoNamesOne struct {
		Inner
		Name string `json:"name"`
	}
	type quotedName struct {
		S string `json:"a-b"`
	}
	type generic struct {
		G Gen[int] `json:"g"`
	}
	for name, c := range map[string]struct {
		v    any
		want string
	}{
		"own MarshalJSON, embedded": {embedsMarshaler{}, "marshals itself"},
		"own MarshalJSON, field":    {fieldMarshaler{}, "marshals itself"},
		"pointer receiver":          {pointerMarshaler{}, "marshals itself"},
		"MarshalText":               {textMarshaler{}, "marshals itself"},
		"marshaling byte":           {byteMarshaler{}, "marshals itself"},
		"interface field":           {withInterface{}, "no TypeScript"},
		"non-string key":            {withIntKey{}, "not a string"},
		"unsupported opts":          {withOption{}, "not supported"},
		"duplicate name":            {twoNamesOne{}, "two fields"},
		"name needing quotes":       {quotedName{}, "not a plain identifier"},
		"generic":                   {generic{}, "generic type"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := newTestGenerator().fields(reflect.TypeOf(c.v))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v, want one saying %q", err, c.want)
			}
		})
	}
}

type selfMarshaling struct{}

func (selfMarshaling) MarshalJSON() ([]byte, error) { return []byte(`1`), nil }

type pointerMarshaling struct{}

func (*pointerMarshaling) MarshalJSON() ([]byte, error) { return []byte(`1`), nil }

type textMarshaling struct{}

func (textMarshaling) MarshalText() ([]byte, error) { return []byte(`t`), nil }

type byteMarshaling uint8

func (byteMarshaling) MarshalJSON() ([]byte, error) { return []byte(`"b"`), nil }

type Gen[T any] struct {
	V T `json:"v"`
}

// A wire type's own field cannot take the discriminator's key.
func TestGenerateRefusesAFieldNamedType(t *testing.T) {
	type typed struct {
		Kind string `json:"type"`
	}
	err := newTestGenerator().declareStruct(reflect.TypeOf(typed{}), "x")
	if err == nil || !strings.Contains(err.Error(), "discriminator") {
		t.Errorf("err = %v", err)
	}
}

func newTestGenerator() *generator {
	return &generator{
		moduleRoot: moduleRoot,
		packages:   map[string]*packageSource{},
		named:      map[reflect.Type]string{},
		names:      map[string]reflect.Type{},
	}
}

type Inner struct {
	Name string `json:"name"`
}

// What encoding/json does that a field-by-field reading would miss.
func TestFieldsFollowEncodingJSON(t *testing.T) {
	type unexported struct {
		X int `json:"x"`
	}
	type v struct {
		// Through a nil pointer, none of Inner's fields is written.
		*Inner
		// Embedded but named by its tag: a field, unexported or not.
		unexported `json:"in"`
		// A struct value is written even when zero.
		At    time.Time         `json:"at,omitempty"`
		Slice *[]string         `json:"slice,omitempty"`
		Bytes []byte            `json:"bytes"`
		Ptrs  []*Inner          `json:"ptrs,omitempty"`
		Map   map[string]*Inner `json:"map,omitempty"`
	}
	fields, err := newTestGenerator().fields(reflect.TypeOf(v{}))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, f := range fields {
		opt := ""
		if f.optional {
			opt = "?"
		}
		got[f.name+opt] = f.ts
	}
	want := map[string]string{
		"name?":  "string",
		"in":     "unexported",
		"at":     "string",
		"slice?": "string[] | null",
		"bytes":  "string | null",
		"ptrs?":  "(Inner | null)[]",
		"map?":   "Record<string, Inner | null>",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("fields = %v, want %v", got, want)
	}
}

// A constant whose value is not a string literal would leave a member out of
// the union without a word; it fails instead.
func TestConstsRefuseWhatTheyCannotRead(t *testing.T) {
	for name, decl := range map[string]string{
		"conversion": `const A = Kind("a")`,
		"iota":       "const (\n\tA Kind = iota\n\tB\n)",
		"reference":  "const (\n\tA Kind = \"a\"\n\tB Kind = A\n)",
	} {
		t.Run(name, func(t *testing.T) {
			src := parseConsts(t, decl)
			if !src.unreadable["Kind"] {
				t.Errorf("Kind not marked unreadable; consts %v", src.consts)
			}
		})
	}
	src := parseConsts(t, "const (\n\tA Kind = \"a\"\n\tB Kind = \"b\"\n)")
	if src.unreadable["Kind"] || !reflect.DeepEqual(src.consts["Kind"], []string{"a", "b"}) {
		t.Errorf("plain constants: consts %v, unreadable %v", src.consts, src.unreadable)
	}
}

func parseConsts(t *testing.T, decl string) *packageSource {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "x.go", "package x\n"+decl, 0)
	if err != nil {
		t.Fatal(err)
	}
	src := &packageSource{consts: map[string][]string{}, unreadable: map[string]bool{}}
	for _, d := range file.Decls {
		if err := src.addConsts(d.(*ast.GenDecl), ownType); err != nil {
			t.Fatal(err)
		}
	}
	return src
}

// The forms of constant that parsing would file somewhere the type's union does
// not look: through an alias, wrapped in an expression, or in another package.
func TestConstsOutsideTheUnionAreFound(t *testing.T) {
	for name, decl := range map[string]string{
		"alias":              "type Alias = Kind\nconst A Alias = \"a\"",
		"local alias":        "func f() {\n\ttype K = Kind\n\tconst C K = \"c\"\n\t_ = C\n}",
		"wrapped conversion": `const A = Kind("a") + ""`,
		"parenthesized":      `const A = (Kind)("a")`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			write(t, filepath.Join(dir, "x.go"), "package x\n"+decl+"\n")
			src, err := parsePackage(dir)
			if err != nil {
				t.Fatal(err)
			}
			if !src.unreadable["Kind"] {
				t.Errorf("Kind not marked unreadable")
			}
		})
	}

	t.Run("another package", func(t *testing.T) {
		for name, decl := range map[string]string{
			"conversion":  "import k \"github.com/pockode/server/a\"\nconst C = k.Kind(\"c\")\n",
			"iota":        "import \"github.com/pockode/server/a\"\nconst (\n\tB a.Kind = \"b\"\n\tC\n)\n",
			"alias":       "import \"github.com/pockode/server/a\"\ntype K = a.Kind\nconst C K = \"c\"\n",
			"local alias": "import \"github.com/pockode/server/a\"\nfunc f() {\n\ttype K = a.Kind\n\tconst C K = \"c\"\n\t_ = C\n}\n",
		} {
			t.Run(name, func(t *testing.T) {
				root := t.TempDir()
				write(t, filepath.Join(root, "a", "a.go"), "package a\ntype Kind string\n")
				write(t, filepath.Join(root, "b", "b.go"), "package b\n"+decl)
				g := newTestGenerator()
				g.moduleRoot = root
				foreign, err := g.foreignConsts()
				if err != nil {
					t.Fatal(err)
				}
				if !foreign.unreadable[modulePath+"/a.Kind"] {
					t.Errorf("a.Kind not marked unreadable; consts %v", foreign.consts)
				}
			})
		}
	})
}

// A type can be given its values by the packages that know what each means,
// as agent.MessageSubtype is: those join the union after the type's own,
// however the constant names the type.
func TestConstsFromAnotherPackageJoinTheUnion(t *testing.T) {
	root := t.TempDir()
	// Package a lives in a directory named otherwise, so an import of it
	// without a name brings in "a", not "dir".
	write(t, filepath.Join(root, "dir", "a.go"), "package a\ntype Kind string\ntype Level int\nconst A Kind = \"a\"\n")
	write(t, filepath.Join(root, "b", "b.go"),
		"package b\nimport \"github.com/pockode/server/dir\"\nconst (\n\tB1 a.Kind = \"b1\"\n\tB2 a.Kind = \"b2\"\n)\n")
	write(t, filepath.Join(root, "c", "c.go"),
		"package c\nimport k \"github.com/pockode/server/dir\"\nconst C (k.Kind) = \"c\"\nconst L k.Level = 3\n"+
			"func f() k.Kind {\n\tconst D k.Kind = \"d\"\n\treturn D\n}\n")
	g := newTestGenerator()
	g.moduleRoot = root
	foreign, err := g.foreignConsts()
	if err != nil {
		t.Fatal(err)
	}
	key := modulePath + "/dir.Kind"
	if want := []string{"b1", "b2", "c", "d"}; !reflect.DeepEqual(foreign.consts[key], want) || foreign.unreadable[key] {
		t.Errorf("consts = %v (unreadable %v), want %v", foreign.consts[key], foreign.unreadable[key], want)
	}
}

// A type a function declares shadows the package's own of that name, so its
// constants are not the package type's — refused or added, either would be
// wrong.
func TestConstsOfAShadowingLocalTypeAreNotThePackageTypes(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "x.go"), "package x\ntype Kind string\nconst A Kind = \"a\"\n"+
		"func f() {\n\ttype Kind int\n\tconst C Kind = 3\n\t_ = C\n}\n"+
		"var g = func() {\n\ttype Kind string\n\tconst D Kind = \"d\"\n\t_ = D\n}\n"+
		"func h() {\n\tconst E Kind = \"e\"\n\t_ = E\n}\n")
	src, err := parsePackage(dir)
	if err != nil {
		t.Fatal(err)
	}
	if src.unreadable["Kind"] || !reflect.DeepEqual(src.consts["Kind"], []string{"a", "e"}) {
		t.Errorf("consts = %v, unreadable = %v; want [a e], readable", src.consts["Kind"], src.unreadable["Kind"])
	}
}

// Another package can write a constant through an alias the type's own
// package declares; it files under the alias's name, which reflection never
// shows, so the type is refused rather than left without the value.
func TestConstsThroughTheTypesOwnAliasRefuse(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "agent", "kind.go"), "package agent\ntype Kind string\ntype Alias = Kind\n")
	write(t, filepath.Join(root, "b", "b.go"), "package b\nimport \"github.com/pockode/server/agent\"\nconst C agent.Alias = \"c\"\n")
	g := newTestGenerator()
	g.moduleRoot = root
	src, err := parsePackage(filepath.Join(root, "agent"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.constValues(src, modulePath+"/agent", "Kind"); err == nil || !strings.Contains(err.Error(), "alias") {
		t.Errorf("err = %v, want the alias refused", err)
	}
}

// A generator script beside a package (`//go:build ignore`, `package main`)
// is not what an import of that package brings in.
func TestPackageNameSkipsConstrainedFiles(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "dir", "0gen.go"), "//go:build ignore\n\npackage main\n")
	write(t, filepath.Join(root, "dir", "a.go"), "package a\n")
	write(t, filepath.Join(root, "mixed", "a.go"), "package a\n")
	write(t, filepath.Join(root, "mixed", "b.go"), "package b\n")
	g := newTestGenerator()
	g.moduleRoot = root
	if name, err := g.packageName(modulePath + "/dir"); err != nil || name != "a" {
		t.Errorf("name = %q, %v; want a", name, err)
	}
	if _, err := g.packageName(modulePath + "/mixed"); err == nil {
		t.Error("two package names in one directory: want an error")
	}
}

// A dot import names the package's types without saying whose they are, so
// the generator cannot tell its constants from the importing package's own.
func TestConstsThroughADotImportAreFound(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "a", "a.go"), "package a\ntype Kind string\n")
	write(t, filepath.Join(root, "b", "b.go"), "package b\nimport . \"github.com/pockode/server/a\"\nconst C Kind = \"c\"\n")
	g := newTestGenerator()
	g.moduleRoot = root
	foreign, err := g.foreignConsts()
	if err != nil {
		t.Fatal(err)
	}
	if !foreign.dotImported[modulePath+"/a"] {
		t.Errorf("dotImported = %v, want a in it", foreign.dotImported)
	}
}

func TestUnionMembersRefuseAValueTwice(t *testing.T) {
	type Kind string
	if _, err := unionMembers(reflect.TypeFor[Kind](), []string{"a", "b", "a"}); err == nil || !strings.Contains(err.Error(), `"a" twice`) {
		t.Errorf("err = %v, want the repeated value refused", err)
	}
	got, err := unionMembers(reflect.TypeFor[Kind](), []string{"a", "b"})
	if err != nil || !reflect.DeepEqual(got, []string{`"a"`, `"b"`}) {
		t.Errorf("members = %v, %v", got, err)
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The generated interfaces against what the Go types really write: for every
// wire type, filled in down to its last field, each key it marshals is one its
// interface declares, and each key it declares is one it marshals.
func TestGeneratedMatchesMarshaledKeys(t *testing.T) {
	out, err := Generate(moduleRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range agent.WireTypes() {
		typ := reflect.TypeOf(w)
		t.Run(typ.Name(), func(t *testing.T) {
			v := reflect.New(typ).Elem()
			fill(v)
			raw, err := json.Marshal(v.Interface())
			if err != nil {
				t.Fatal(err)
			}
			var obj map[string]json.RawMessage
			if err := json.Unmarshal(raw, &obj); err != nil {
				t.Fatal(err)
			}
			if got := string(obj["type"]); got != strconv.Quote(string(w.Type())) {
				t.Errorf("type = %s, want %q", got, w.Type())
			}
			marshaled := slices.Sorted(maps.Keys(obj))
			declared := declaredKeys(t, string(out), typ.Name())
			if !slices.Equal(marshaled, declared) {
				t.Errorf("marshaled keys %v, declared %v", marshaled, declared)
			}
		})
	}
}

// fill sets every field of v to something non-zero, so omitempty keeps it.
func fill(v reflect.Value) {
	switch v.Kind() {
	case reflect.Struct:
		if v.Type() == reflect.TypeFor[time.Time]() {
			v.Set(reflect.ValueOf(time.Unix(1, 0)))
			return
		}
		for i := range v.NumField() {
			if v.Field(i).CanSet() {
				fill(v.Field(i))
			}
		}
	case reflect.Pointer:
		v.Set(reflect.New(v.Type().Elem()))
		fill(v.Elem())
	case reflect.Slice:
		if v.Type() == reflect.TypeFor[json.RawMessage]() {
			v.SetBytes([]byte(`{}`))
			return
		}
		v.Set(reflect.MakeSlice(v.Type(), 1, 1))
		fill(v.Index(0))
	case reflect.Map:
		v.Set(reflect.MakeMap(v.Type()))
		elem := reflect.New(v.Type().Elem()).Elem()
		fill(elem)
		v.SetMapIndex(reflect.ValueOf("k").Convert(v.Type().Key()), elem)
	case reflect.String:
		v.SetString("x")
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(1)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(1)
	case reflect.Float32, reflect.Float64:
		v.SetFloat(1)
	}
}

// declaredKeys are the properties of the named interface in the generated file.
func declaredKeys(t *testing.T, out, name string) []string {
	t.Helper()
	body := between(out, "export interface "+name+" {\n", "\n}\n")
	if body == "" {
		t.Fatalf("no interface %s", name)
	}
	var keys []string
	for line := range strings.SplitSeq(body, "\n") {
		if !strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "\t/**") || strings.HasPrefix(line, "\t *") {
			continue
		}
		key, _, _ := strings.Cut(strings.TrimPrefix(line, "\t"), ":")
		keys = append(keys, strings.TrimSuffix(key, "?"))
	}
	slices.Sort(keys)
	return keys
}
