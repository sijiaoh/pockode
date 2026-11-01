package canvas

import (
	"errors"
	"strings"
	"testing"
)

func ptr(s string) *string { return &s }

func problems(t *testing.T, err error) []string {
	t.Helper()
	var r *Rejection
	if !errors.As(err, &r) {
		t.Fatalf("err = %v, want a *Rejection", err)
	}
	return r.Problems
}

func TestCheckRender_Normalizes(t *testing.T) {
	page, err := CheckRender(`<button data-pk-send="go">Go`, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := `<html><head></head><body><button data-pk-send="go">Go</button></body></html>`
	if page.HTML != want {
		t.Errorf("HTML = %q, want %q", page.HTML, want)
	}
	if len(page.Warnings) != 0 {
		t.Errorf("Warnings = %q, want none", page.Warnings)
	}
}

func TestCheckRender_VoidElementListsEveryError(t *testing.T) {
	_, err := CheckRender(`<svg><track><rect/></track></svg><p data-pk-region="a"></p><p data-pk-region="a"></p>`, 0)
	got := problems(t, err)
	if len(got) != 2 || !strings.HasPrefix(got[0], "<track> cannot hold anything") {
		t.Errorf("problems = %q, want the <track> one, then the duplicate region", got)
	}
}

func TestCheckRender_Refusals(t *testing.T) {
	tests := []struct {
		name string
		html string
		want string
	}{
		{"whitespace", " \n\t", "The page is empty"},
		{"over the limit", `<button data-pk-send="go"></button>` + strings.Repeat("x", MaxDocumentBytes), "bytes, over the 256KB limit"},
		// Every <p> gains a </p>, so the stored document outgrows the html.
		{"over the limit once serialized", `<button data-pk-send="go"></button>` + strings.Repeat("<p>", MaxDocumentBytes/4), "bytes, over the 256KB limit"},
		{"nested over 512 deep", `<button data-pk-send="go"></button>` + strings.Repeat("<div>", 600), msgTooDeep},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := CheckRender(tt.html, 0)
			got := problems(t, err)
			if len(got) != 1 || !strings.Contains(got[0], tt.want) {
				t.Errorf("problems = %q, want one containing %q", got, tt.want)
			}
		})
	}
}

const base = `<button data-pk-send="go">Go</button>` +
	`<ul data-pk-region="results"><li>a</li></ul>` +
	`<div data-pk-region="log"><p>1</p></div>` +
	`<table><tbody data-pk-region="rows"></tbody></table>` +
	`<img data-pk-region="pic" src="a.png">` +
	`<script data-pk-region="code"></script><textarea data-pk-region="note"></textarea>` +
	`<select data-pk-region="choice"></select><svg><style data-pk-region="svgstyle"></style></svg>` +
	`<div data-pk-region="after"></div>`

func stored(t *testing.T) string {
	t.Helper()
	page, err := CheckRender(base, 0)
	if err != nil {
		t.Fatal(err)
	}
	return page.HTML
}

func TestApplyUpdate(t *testing.T) {
	tests := []struct {
		name     string
		ops      []Op
		contains []string
		absent   []string
	}{
		{
			name:     "replace swaps the contents and keeps the element",
			ops:      []Op{{Op: OpReplace, Region: "results", HTML: ptr("<li>b</li>")}},
			contains: []string{`<ul data-pk-region="results"><li>b</li></ul>`},
		},
		{
			name:     "replace with empty html empties the region",
			ops:      []Op{{Op: OpReplace, Region: "results", HTML: ptr("")}},
			contains: []string{`<ul data-pk-region="results"></ul>`},
		},
		{
			name:     "append adds at the end",
			ops:      []Op{{Op: OpAppend, Region: "log", HTML: ptr("<p>2</p>")}},
			contains: []string{`<div data-pk-region="log"><p>1</p><p>2</p></div>`},
		},
		{
			name:   "remove deletes the element",
			ops:    []Op{{Op: OpRemove, Region: "log"}},
			absent: []string{`data-pk-region="log"`},
		},
		{
			name:     "html is parsed in the region's context, as innerHTML",
			ops:      []Op{{Op: OpReplace, Region: "rows", HTML: ptr("<tr><td>1</td></tr>")}},
			contains: []string{`<tbody data-pk-region="rows"><tr><td>1</td></tr></tbody>`},
		},
		{
			name: "a later op sees the region an earlier one created",
			ops: []Op{
				{Op: OpReplace, Region: "log", HTML: ptr(`<span data-pk-region="inner"></span>`)},
				{Op: OpAppend, Region: "inner", HTML: ptr("hi")},
			},
			contains: []string{`<span data-pk-region="inner">hi</span>`},
		},
		{
			name:     "a script region takes its html as text, as innerHTML",
			ops:      []Op{{Op: OpReplace, Region: "code", HTML: ptr(`if (a < b && c) x = "<b>"`)}},
			contains: []string{`<script data-pk-region="code">if (a < b && c) x = "<b>"</script>`},
		},
		{
			name:     "a comment opener alone in a script region is text",
			ops:      []Op{{Op: OpReplace, Region: "code", HTML: ptr(`var s = "<!-- -->";`)}},
			contains: []string{`<script data-pk-region="code">var s = "<!-- -->";</script>`},
		},
		{
			name:     "the legacy comment-wrapped document.write is text",
			ops:      []Op{{Op: OpReplace, Region: "code", HTML: ptr("<!--\ndocument.write('<script src=x><\\/script>');\n//-->")}},
			contains: []string{"<!--\ndocument.write('<script src=x><\\/script>');\n//--></script>"},
		},
		{
			name:     "<scripting is no script tag",
			ops:      []Op{{Op: OpReplace, Region: "code", HTML: ptr(`// <!-- <scripting`)}},
			contains: []string{`// <!-- <scripting</script>`},
		},
		{
			name:     "a closed comment before a script tag is text",
			ops:      []Op{{Op: OpReplace, Region: "code", HTML: ptr(`var s = "<!-- -->", t = "<!-->"; x.innerHTML = "<script>";`)}},
			contains: []string{`var s = "<!-- -->", t = "<!-->"; x.innerHTML = "<script>";</script>`},
		},
		{
			name:     "options in a select region",
			ops:      []Op{{Op: OpReplace, Region: "choice", HTML: ptr("<option>a<option>b")}},
			contains: []string{`<select data-pk-region="choice"><option>a</option><option>b</option></select>`},
		},
		{
			name:     "a textarea region decodes character references",
			ops:      []Op{{Op: OpReplace, Region: "note", HTML: ptr(`a &amp; <b>`)}},
			contains: []string{`<textarea data-pk-region="note">a &amp; &lt;b&gt;</textarea>`},
		},
		{
			name:   "a void region can be emptied and removed",
			ops:    []Op{{Op: OpReplace, Region: "pic", HTML: ptr("")}, {Op: OpRemove, Region: "pic"}},
			absent: []string{"<img"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, err := ApplyUpdate(stored(t), tt.ops, 0)
			if err != nil {
				t.Fatal(err)
			}
			for _, s := range tt.contains {
				if !strings.Contains(page.HTML, s) {
					t.Errorf("HTML = %q, want it to contain %q", page.HTML, s)
				}
			}
			for _, s := range tt.absent {
				if strings.Contains(page.HTML, s) {
					t.Errorf("HTML = %q, want no %q", page.HTML, s)
				}
			}
		})
	}
}

func TestApplyUpdate_Refusals(t *testing.T) {
	tests := []struct {
		name     string
		noCanvas bool
		current  string // the base page when empty
		ops      []Op
		want     []string
	}{
		{
			name:     "no canvas yet",
			noCanvas: true,
			ops:      []Op{{Op: OpRemove, Region: "log"}},
			want:     []string{"There is no canvas yet: draw the whole page with canvas_render first."},
		},
		{
			name: "no ops",
			want: []string{"ops is empty: pass at least one op (replace, append or remove)."},
		},
		{
			name: "every malformed op is listed",
			ops: []Op{
				{Op: OpReplace, Region: "log"},
				{Op: OpAppend, Region: "log", HTML: ptr("")},
				{Op: OpRemove, Region: "log", HTML: ptr("")},
				{Op: "insert", Region: "log"},
				{Op: OpRemove},
			},
			want: []string{
				"ops[0]: replace needs html",
				"ops[1]: append needs html",
				"ops[2]: remove takes no html",
				`ops[3]: unknown op "insert": use replace, append or remove`,
				"ops[4]: remove needs a region: the data-pk-region name of the element to change",
			},
		},
		{
			name: "missing regions list the existing ones, as each op found the page",
			ops: []Op{
				{Op: OpRemove, Region: "resluts"},
				{Op: OpRemove, Region: "log"},
				{Op: OpAppend, Region: "log", HTML: ptr("x")},
			},
			want: []string{
				`There is no region "resluts". Regions on the page: results, log, rows, pic, code, note, choice, svgstyle, after.`,
				`There is no region "log". Regions on the page: results, rows, pic, code, note, choice, svgstyle, after.`,
			},
		},
		{
			name:    "a page without regions says how to make one",
			current: `<html><head></head><body><button data-pk-send="go"></button></body></html>`,
			ops:     []Op{{Op: OpRemove, Region: "log"}},
			want:    []string{`There is no region "log": the page has no regions — mark the element with data-pk-region="name", or redraw with canvas_render.`},
		},
		{
			name: "a void region cannot hold contents",
			ops:  []Op{{Op: OpAppend, Region: "pic", HTML: ptr("x")}},
			want: []string{`ops[0]: region "pic" is an <img>, which cannot hold contents: mark an element around it with data-pk-region instead, or replace the whole element through its parent region.`},
		},
		{
			name: "a raw-text region's own end tag",
			ops:  []Op{{Op: OpAppend, Region: "code", HTML: ptr(`s = "</SCRIPT><p>"`)}},
			want: []string{`ops[0]: <script> region "code" would contain "</script", which would end the element when the page is drawn: write it as "<\/script" instead.`},
		},
		{
			name: "a comment opener and a script tag in a script region",
			ops:  []Op{{Op: OpReplace, Region: "code", HTML: ptr(`var s = "<!--<SCRIPT>";`)}},
			want: []string{`ops[0]: <script> region "code" would contain "<script" inside "<!--" with no "-->" after it, which makes the browser read the rest of the page as script: close it with "-->", or write "<\!--" instead.`},
		},
		{
			name: "a script tag closed but escaped again",
			ops:  []Op{{Op: OpReplace, Region: "code", HTML: ptr(`a("<!-- <script> -->"); b("<!-- <script>")`)}},
			want: []string{`ops[0]: <script> region "code" would contain "<script" inside "<!--" with no "-->" after it, which makes the browser read the rest of the page as script: close it with "-->", or write "<\!--" instead.`},
		},
		{
			name: "an append completing what the script region already holds",
			ops: []Op{
				{Op: OpReplace, Region: "code", HTML: ptr(`var a = "<!--";`)},
				{Op: OpAppend, Region: "code", HTML: ptr(`var b = "<script>";`)},
			},
			want: []string{`ops[1]: <script> region "code" would contain "<script" inside "<!--" with no "-->" after it, which makes the browser read the rest of the page as script: close it with "-->", or write "<\!--" instead.`},
		},
		{
			name: "an op's html over the limit is refused unparsed",
			ops:  []Op{{Op: OpAppend, Region: "log", HTML: ptr(strings.Repeat("x", MaxDocumentBytes+1))}},
			want: []string{"ops[0]: " + msgTooLarge(MaxDocumentBytes+1)},
		},
		{
			name: "a page that would not read back as written",
			// Everything after a <plaintext> is its text once parsed again.
			ops:  []Op{{Op: OpReplace, Region: "log", HTML: ptr("<plaintext>")}},
			want: []string{"The page does not read back as written: regions rows, pic, code, note, choice, svgstyle, after are lost, because something before them — markup inside a <script>, <style> or <svg>, or a <plaintext> — swallows the rest. Check what this call puts there."},
		},
		{
			name: "html nested over 512 deep",
			ops:  []Op{{Op: OpAppend, Region: "log", HTML: ptr(strings.Repeat("<i>", 600))}},
			want: []string{"ops[0]: " + msgTooDeep},
		},
		{
			name:    "a region inside a template cannot be targeted",
			current: `<html><head></head><body><button data-pk-send="go"></button><template><li data-pk-region="row"></li></template></body></html>`,
			ops:     []Op{{Op: OpReplace, Region: "row", HTML: ptr("x")}},
			want:    []string{`There is no region "row": the page has no regions — mark the element with data-pk-region="name", or redraw with canvas_render.`},
		},
		{
			name: "an update that pushes the page over 512 deep",
			ops:  []Op{{Op: OpAppend, Region: "log", HTML: ptr(strings.Repeat("<i>", 510))}},
			want: []string{msgTooDeep},
		},
		{
			name: "a void element inside the html of an op",
			ops:  []Op{{Op: OpAppend, Region: "log", HTML: ptr(`<svg><source><rect/></source></svg>`)}},
			want: []string{"<source> cannot hold anything, but the page puts content inside one: it has no closing tag, so put that content after it, or use another element."},
		},
		{
			name: "the result is linted",
			ops:  []Op{{Op: OpReplace, Region: "rows", HTML: ptr(`<tr data-pk-region="results"></tr>`)}, {Op: OpReplace, Region: "log", HTML: ptr("")}},
			want: []string{`Region "results" is used 2 times: region names must be unique — rename one, or remove the duplicate.`},
		},
		{
			name:    "an update that leaves the page empty",
			current: `<html><head></head><body><div data-pk-region="a"><button data-pk-send="go"></button></div></body></html>`,
			ops:     []Op{{Op: OpRemove, Region: "a"}},
			want:    []string{msgEmpty},
		},
		{
			name: "an update over the limit",
			ops:  []Op{{Op: OpAppend, Region: "log", HTML: ptr(strings.Repeat("x", MaxDocumentBytes))}},
			want: []string{msgTooLarge(len(stored(t)) + MaxDocumentBytes)},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			current := tt.current
			if current == "" && !tt.noCanvas {
				current = stored(t)
			}
			_, err := ApplyUpdate(current, tt.ops, 0)
			got := problems(t, err)
			if strings.Join(got, "\n") != strings.Join(tt.want, "\n") {
				t.Errorf("problems =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(tt.want, "\n"))
			}
		})
	}
}

func TestApplyUpdate_ReportsOnlyNewWarnings(t *testing.T) {
	current, err := CheckRender(`<button data-pk-send="go"></button><div data-pk-region="a" style="position: fixed">`+
		`<p style="color: #111; background: #222"></p><img src="https://one.example.com/a.png"><input></div>`, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(current.Warnings) != 4 {
		t.Fatalf("render warnings = %q, want hosts, fixed, colours and the unsent field", current.Warnings)
	}

	tests := []struct {
		name string
		html string
		want []string
	}{
		{
			name: "what was already said is not repeated",
			html: `<p style="color: #111; background: #222"></p><img src="https://one.example.com/a.png"><input>`,
		},
		{
			name: "fewer of a kind is not new",
			html: `<p style="color: #111"></p>`,
		},
		{
			name: "more of a kind is",
			html: `<p style="color: #111; background: #222; border-color: #333"></p><img src="https://one.example.com/a.png"><img src="https://two.example.com/b.png">`,
			want: []string{
				"Loads from one.example.com, two.example.com: the user must allow each host before it loads, and until then it is missing. Prefer project files or inline code.",
				"3 hard-coded colours: they will not follow the user's light/dark theme. Use the --pk-* variables (for example color: var(--pk-text)).",
			},
		},
		{
			// Unnamed fields without an id are all listed as "input".
			name: "one more field like one already listed is",
			html: `<input><input>`,
			want: []string{"2 fields do nothing: no send carries them and no script reads them: input, input. To send a field, give it a name inside a form with data-pk-send; otherwise remove it."},
		},
		{
			name: "a new kind is",
			html: `<script>alert(1)</script>`,
			want: []string{"alert/confirm/prompt do nothing here: show the message in the page instead."},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, err := ApplyUpdate(current.HTML, []Op{{Op: OpReplace, Region: "a", HTML: ptr(tt.html)}}, 0)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(page.Warnings, "\n") != strings.Join(tt.want, "\n") {
				t.Errorf("warnings =\n%s\nwant\n%s", strings.Join(page.Warnings, "\n"), strings.Join(tt.want, "\n"))
			}
		})
	}
}
