package canvas

import (
	"strings"
	"testing"
)

// send keeps a test page past the nothing-can-send check, so each case shows
// only the rule it is about.
const send = `<button data-pk-send="go">Go</button>`

func TestCheckRender_Errors(t *testing.T) {
	tests := []struct {
		name string
		html string
		want []string // exact, in order; nil means the page is accepted
	}{
		{name: "comments only", html: "<!-- nothing -->", want: []string{msgEmpty}},
		{name: "head only", html: "<style>p{}</style><title>x</title>", want: []string{msgEmpty}},
		{name: "a script alone may draw the page", html: `<script>document.body.append("hi"); pockode.send("ready")</script>`},
		{
			name: "nothing can send",
			html: "<p>hello</p>",
			want: []string{`Nothing on this page can send anything back: add a button with data-pk-send="action", a form with data-pk-send, or call pockode.send(action, data) from a script.`},
		},
		{name: "pockode.send in a script sends", html: `<p>x</p><script>btn.onclick = () => pockode.send("x")</script>`},
		{name: "pockode.send in a handler sends", html: `<p onclick="pockode.send('x')">x</p>`},
		{name: "pockode.send in a javascript: link sends", html: `<a href="javascript:pockode.send('x')">x</a>`},
		{name: "a script from a file may send", html: `<p>x</p><script src="app.js"></script>`},
		{name: "pockode reached another way sends", html: `<p>x</p><script>window.pockode?.send("x"); const { send } = pockode</script>`},
		{name: "a module importing a file may send", html: `<p>x</p><script type="module">import { init } from "./app.js"; init()</script>`},
		{name: "a dynamic import may send", html: `<p>x</p><script>import("./app.js")</script>`},
		{name: "a javascript: form action sends", html: `<form action="javascript:pockode.send('x', {})"><button>Go</button></form>`},
		{
			name: "a word starting with import is no import",
			html: `<p>x</p><script>el.style.setProperty("color", "red", "important") // imports later</script><script type="importmap">{"imports": {}}</script>`,
			want: []string{`Nothing on this page can send anything back: add a button with data-pk-send="action", a form with data-pk-send, or call pockode.send(action, data) from a script.`},
		},
		{
			name: "a word containing pockode is not pockode",
			html: `<p>x</p><script>const mypockode = 1; pockodes()</script>`,
			want: []string{`Nothing on this page can send anything back: add a button with data-pk-send="action", a form with data-pk-send, or call pockode.send(action, data) from a script.`},
		},
		{
			name: "pockode.send in text is not a script",
			html: "<p>call pockode.send to send</p>",
			want: []string{`Nothing on this page can send anything back: add a button with data-pk-send="action", a form with data-pk-send, or call pockode.send(action, data) from a script.`},
		},
		{
			name: "unnamed form fields are listed per form",
			html: `<form data-pk-send="create"><input id="title"><input type="checkbox"><select></select><textarea></textarea>` +
				`<input name="ok"><input type="submit"><input type="hidden"><input disabled><button>Create</button></form>`,
			want: []string{`The form data-pk-send="create" has fields without a name, which are not sent: give each field a name attribute (for example <input name="title">). Unnamed: input#title, input[type="checkbox"], select, textarea.`},
		},
		{name: "an empty name counts as none", html: `<form data-pk-send="c"><input name=""></form>`, want: []string{
			`The form data-pk-send="c" has fields without a name, which are not sent: give each field a name attribute (for example <input name="title">). Unnamed: input.`,
		}},
		{name: "a plain form is not checked", html: send + `<form><input></form><script>pockode.send</script>`},
		{name: "an input with its own send needs no name in a form", html: `<form data-pk-send="c"><input data-pk-send="q"></form>`},
		{
			name: "a field the page acts on itself needs no name",
			html: `<form data-pk-send="s"><input name="q"><input type="checkbox" onchange="adv.hidden = !this.checked"><button>Go</button></form>`,
		},
		{
			name: "a disabled field needs no name",
			html: `<form data-pk-send="f"><input disabled><fieldset disabled><input><select></select></fieldset><button>Go</button></form>`,
		},
		{
			name: "a field joins the form its form attribute names",
			html: send + `<form id="f" data-pk-send="f"></form><input form="f"><input form="nowhere" name="x"><script>pockode.send</script>`,
			want: []string{`The form data-pk-send="f" has fields without a name, which are not sent: give each field a name attribute (for example <input name="title">). Unnamed: input.`},
		},
		{
			name: "template fields are inert until cloned",
			html: `<form data-pk-send="add"><template><input><button data-pk-send="x"></button></template><button>Add</button></form><script>pockode.send</script>`,
		},
		{name: "an svg script from a file may send", html: `<p>x</p><svg><script href="app.js"></script></svg>`},
		{
			name: "a file input with data-pk-send",
			html: `<input type="file" data-pk-send="up">`,
			want: []string{`<input type="file" data-pk-send="up"> cannot be sent with Enter: put it in a form with data-pk-send and a submit button, or use a text input.`},
		},
		{
			name: "input data-pk-send that holds no text",
			html: `<input type="checkbox" data-pk-send="toggle"><input type="BUTTON" data-pk-send="b">`,
			want: []string{
				`<input type="checkbox" data-pk-send="toggle"> cannot be sent with Enter: put it in a form with data-pk-send and a submit button, or use a text input.`,
				`<input type="button" data-pk-send="b"> cannot be sent with Enter: put it in a form with data-pk-send and a submit button, or use a text input.`,
			},
		},
		{name: "text-holding inputs send on Enter", html: `<input data-pk-send="a"><input type="search" data-pk-send="b"><input type="number" data-pk-send="c"><input type="fancy" data-pk-send="d">`},
		{
			name: "select and textarea cannot send by themselves",
			html: `<select data-pk-send="s"></select><textarea data-pk-send="t"></textarea>`,
			want: []string{
				`<select data-pk-send="s"> cannot send by itself: put it in a form with data-pk-send and a submit button.`,
				`<textarea data-pk-send="t"> cannot send by itself: put it in a form with data-pk-send and a submit button.`,
			},
		},
		{
			name: "duplicate regions",
			html: send + `<div data-pk-region="a"></div><p data-pk-region="b"></p><span data-pk-region="a"></span><i data-pk-region="a"></i>`,
			want: []string{`Region "a" is used 3 times: region names must be unique — rename one, or remove the duplicate.`},
		},
		{name: "a region inside a template is not on the page", html: send + `<ul data-pk-region="row"></ul><template><li data-pk-region="row"></li></template>`},
		{name: "region names are case-sensitive", html: send + `<div data-pk-region="a"></div><div data-pk-region="A"></div>`},
		{
			name: "empty action and region names",
			html: `<button data-pk-send="">x</button><div data-pk-region=""></div><div data-pk-region></div>`,
			want: []string{
				`data-pk-send needs an action name, for example data-pk-send="save".`,
				`data-pk-region needs a name, for example data-pk-region="results".`,
			},
		},
		{
			name: "every error is listed at once",
			html: `<p data-pk-region="a"></p><p data-pk-region="a"></p>`,
			want: []string{
				`Nothing on this page can send anything back: add a button with data-pk-send="action", a form with data-pk-send, or call pockode.send(action, data) from a script.`,
				`Region "a" is used 2 times: region names must be unique — rename one, or remove the duplicate.`,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := CheckRender(tt.html, 0)
			if tt.want == nil {
				if err != nil {
					t.Fatalf("err = %v, want the page accepted", err)
				}
				return
			}
			got := problems(t, err)
			if strings.Join(got, "\n") != strings.Join(tt.want, "\n") {
				t.Errorf("problems =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(tt.want, "\n"))
			}
		})
	}
}

func TestCheckRender_Warnings(t *testing.T) {
	const (
		dialogs = "alert/confirm/prompt do nothing here: show the message in the page instead."
		fixed   = "position: fixed may put content off screen on a small device, and the canvas scrolls: prefer normal flow."
	)
	hosts := func(h string) string {
		return "Loads from " + h + ": the user must allow each host before it loads, and until then it is missing. Prefer project files or inline code."
	}
	const colour = "1 hard-coded colour: it will not follow the user's light/dark theme. Use the --pk-* variables (for example color: var(--pk-text))."
	colours := func(n string) string {
		return n + " hard-coded colours: they will not follow the user's light/dark theme. Use the --pk-* variables (for example color: var(--pk-text))."
	}
	unsentOne := func(field string) string {
		return "1 field can never be sent: " + field + ". Put it in a form with data-pk-send, or send it from a script with pockode.send."
	}
	unsent := func(n, list string) string {
		return n + " fields can never be sent: " + list + ". Put them in a form with data-pk-send, or send them from a script with pockode.send."
	}

	tests := []struct {
		name  string
		html  string
		width int
		want  []string
	}{
		{name: "a clean page", html: send + `<p style="color: var(--pk-text)">x</p><img src="shot.png">`},
		{
			// Attributes first, then each sheet in document order.
			name: "external hosts, each once, from every kind of reference",
			html: send + `<script src="https://cdn.jsdelivr.net/x.js"></script><link href="//Fonts.example.com/a.css" rel="stylesheet">` +
				`<img srcset="a.png 1x, http://img.example.com/b.png 2x"><video poster="https://cdn.jsdelivr.net/p.png"></video>` +
				`<style>@import "https://css.example.com/s.css"; body { background: url('https://bg.example.com/b.png') }</style>` +
				`<div style="background: url(http://inline.example.com/i.png)"></div>`,
			want: []string{hosts("cdn.jsdelivr.net, fonts.example.com, img.example.com, bg.example.com, css.example.com, inline.example.com")},
		},
		{
			name: "a base href moves every relative load",
			html: send + `<base href="https://base.example.com/">`,
			want: []string{hosts("base.example.com")},
		},
		{name: "a link is followed, not loaded", html: send + `<a href="https://example.com">x</a>`},
		{name: "project paths are not hosts", html: send + `<img src="/docs/a.png"><img src="data:image/png;base64,AA">`},
		{name: "dialogs in a script", html: send + `<script>if (confirm ("sure?")) go()</script>`, want: []string{dialogs}},
		{name: "dialogs in a handler", html: send + `<p onclick="alert('x')"></p>`, want: []string{dialogs}},
		{name: "window.alert is the dialog", html: send + `<script>window.alert(1)</script>`, want: []string{dialogs}},
		{name: "a method of the same name is not", html: send + `<script>modal.confirm(1); $prompt(2)</script>`},
		{name: "a dialog word is not a call", html: send + `<script>const prompts = []; myalert(1)</script><p>alert(</p>`},
		{name: "position fixed in a sheet", html: send + `<style>.bar { POSITION : fixed }</style>`, want: []string{fixed}},
		{name: "position fixed in an attribute", html: send + `<div style="position:fixed;top:0"></div>`, want: []string{fixed}},
		{name: "position fixed-ish values are not fixed", html: send + `<style>.a { position: sticky }</style>`},
		{
			name:  "widths wider than the canvas",
			html:  send + `<style>.a { width: 480px } .b { min-width:500.5px } .c { width: 300px } .d { width: 480px }</style><table width="600"></table><svg width="700"><rect width="9000"/></svg>`,
			width: 390,
			want:  []string{"Fixed widths wider than the canvas (390px): 480px, 500.5px, 600px, 700px. The user will have to scroll sideways; use max-width or percentages."},
		},
		{
			name:  "max-width and media queries are not fixed widths",
			html:  send + `<style>.a { max-width: 900px } @media (min-width: 900px) { .a { width: 50% } }</style>`,
			width: 390,
		},
		{
			name:  "a width under a media query applies only where it fits",
			html:  send + `<style>@media (min-width: 900px) { .a { width: 1000px } @supports (display: grid) { .b { width: 1200px } } } .c { width: 800px }</style>`,
			width: 390,
			want:  []string{"Fixed widths wider than the canvas (390px): 800px. The user will have to scroll sideways; use max-width or percentages."},
		},
		{
			name:  "an @import's media query is no width",
			html:  send + `<style>@import "a.css" screen and (min-width: 900px);</style>`,
			width: 390,
		},
		{
			name:  "a style max-width does not size a width attribute",
			html:  send + `<img width="800" style="max-width: 100%">`,
			width: 390,
			want:  []string{"Fixed widths wider than the canvas (390px): 800px. The user will have to scroll sideways; use max-width or percentages."},
		},
		{
			name:  "a high-DPI canvas is drawn at its style's width",
			html:  send + `<canvas width="1170" style="width: 100%"></canvas>`,
			width: 390,
		},
		{name: "widths are not checked without a size", html: send + `<div style="width: 2000px"></div>`},
		{
			name: "colours in declarations, but not in var() fallbacks, selectors or url fragments",
			html: send + `<style>#fff { color: #fff; background: rgb(0 0 0); border-color: var(--pk-border, #ccc) } a:not(#abc) { fill: url(#abc) }</style>` +
				`<p style="color: hsl(0 0% 0%); --mine: #123456"></p>`,
			want: []string{colours("4")},
		},
		{
			name: "colours inside a data: URL are the image's",
			html: send + `<style>.a { background: url("data:image/svg+xml;utf8,<svg fill='%23fff'><rect fill='#ffffff'/></svg>"); color: var(--pk-text) }</style>`,
		},
		{
			name: "fields outside any send",
			html: send + `<input id="q"><select name="s"></select><textarea></textarea><input type="hidden"><input type="submit">` +
				`<form><input name="loose"></form><form data-pk-send="f"><input name="kept"></form><input data-pk-send="own">`,
			want: []string{unsent("4", `input#q, select[name="s"], textarea, input[name="loose"]`)},
		},
		{name: "a data-pk-send button sends its plain form's fields", html: `<form><input name="q"><button data-pk-send="go">Go</button></form>`},
		{
			name: "an unnamed field of a form a button sends never arrives",
			html: `<form><input id="q"><button data-pk-send="go">Go</button></form>`,
			want: []string{unsentOne("input#q")},
		},
		{
			name: "a field of the form its form attribute names is sent",
			html: `<form id="f" data-pk-send="f"><button>Go</button></form><input form="f" name="q">`,
		},
		{
			name:  "media queries written with spaces are not widths",
			html:  send + `<style>@media ( min-width: 900px ) and (width >= 900px) { .a { color: var(--pk-text) } } @container (min-width:900px) {}</style>`,
			width: 390,
		},
		{
			name:  "comments are not CSS",
			html:  send + `<style>/* position: fixed; width: 900px; color: #fff; url(https://x.example.com/a) */</style><p style="/* color: red; position: fixed */"></p>`,
			width: 390,
		},
		{
			name: "non-ASCII text whose lower case is longer",
			html: send + `<p style="content: 'ȺȺȺȺȺȺȺȺȺȺ KKKKKKKKKK var(--x, #fff)'; color: #000"></p><p style="content: '` + "\xff\xff\xff" + ` var(--y)'"></p>`,
			want: []string{colour},
		},
		{name: "a field with its own handler is the page's", html: send + `<input oninput="filter(this.value)"><select onchange="tab(this.value)"></select><input type="file" onchange="read(this)">`},
		{name: "a script may send any field", html: send + `<input id="q"><script>pockode.send("q", {q: q.value})</script>`},
		{
			name: "a file input can never be sent, wherever it is",
			html: `<form data-pk-send="up"><input type="file" name="f"><button>Up</button></form><script>pockode.send</script>`,
			want: []string{unsentOne(`input[name="f"]`)},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, err := CheckRender(tt.html, tt.width)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(page.Warnings, "\n") != strings.Join(tt.want, "\n") {
				t.Errorf("warnings =\n%s\nwant\n%s", strings.Join(page.Warnings, "\n"), strings.Join(tt.want, "\n"))
			}
		})
	}
}
