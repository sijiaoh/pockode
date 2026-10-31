package canvas

import (
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

// The checks of docs/canvas-ui.md §7. They read the parsed tree and are
// deliberately simple: an error is raised only where the check is sure, so
// wherever a script the server cannot read may be doing the work, it stands
// down.

const (
	msgEmpty = "The page is empty: pass the whole page to draw, or use canvas_update to change part of it."
	sendFix  = "add a button with data-pk-send=\"action\", a form with data-pk-send, or call pockode.send(action, data) from a script."
)

func msgTooLarge(n int) string {
	return fmt.Sprintf("The page is %d bytes, over the 256KB limit: move large data, images or libraries into project files and reference them by path.", n)
}

func msgMissingRegion(doc *html.Node, name string) string {
	names := regionNames(doc)
	if len(names) == 0 {
		return fmt.Sprintf("There is no region %q: the page has no regions — mark the element with data-pk-region=\"name\", or redraw with canvas_render.", name)
	}
	return fmt.Sprintf("There is no region %q. Regions on the page: %s.", name, strings.Join(names, ", "))
}

// warning is a lint warning with what an update compares it by: an update
// reports a warning only when the previous revision had no warning of its
// kind, or had fewer of its items or count — a removed colour must not make
// the colour warning look new.
type warning struct {
	kind  string
	items []string
	count int
	text  string
}

func (w warning) grewFrom(before []warning) bool {
	i := slices.IndexFunc(before, func(b warning) bool { return b.kind == w.kind })
	if i < 0 {
		return true
	}
	b := before[i]
	return w.count > b.count || slices.ContainsFunc(w.items, func(item string) bool {
		return !slices.Contains(b.items, item)
	})
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func pronoun(n int) string {
	if n == 1 {
		return "it"
	}
	return "them"
}

func texts(warns []warning) []string {
	var out []string
	for _, w := range warns {
		out = append(out, w.text)
	}
	return out
}

// page is what the checks read off the tree.
type page struct {
	bodyContent bool
	scripts     []string // inline script text, on* handlers and javascript: URLs
	scriptSrc   bool
	css         []string // <style> text and style attributes, comments removed
	sends       int
	emptySend   bool
	emptyRegion bool
	regions     map[string]int
	regionOrder []string
	sendErrors  []string
	unnamed     map[*html.Node][]string // per form[data-pk-send], its unnamed fields
	formOrder   []*html.Node
	unsent      []string // fields no send can carry, for the warning
	files       []string
	hosts       []string
	widthAttrs  []float64

	formsByID map[string]*html.Node
	// sending are the forms whose fields a send carries: form[data-pk-send],
	// and any form a data-pk-send button sits in (docs/canvas-ui.md §6.1).
	sending map[*html.Node]bool
}

// lint checks doc, whose serialization is size bytes. width is the canvas
// width drawn for, 0 when unknown; update picks the wording of an update.
func lint(doc *html.Node, size, width int, update bool) (errs []string, warns []warning) {
	p := collect(doc)

	if size > MaxDocumentBytes {
		errs = append(errs, msgTooLarge(size))
	}
	// A script alone may draw the page, and the parser puts a leading one in
	// <head>.
	if !p.bodyContent && len(p.scripts) == 0 && !p.scriptSrc {
		errs = append(errs, msgEmpty)
	} else if p.sends == 0 && !p.scriptSends() {
		if update {
			errs = append(errs, "After this update nothing on the page could send anything back — "+sendFix)
		} else {
			errs = append(errs, "Nothing on this page can send anything back: "+sendFix)
		}
	}
	for _, form := range p.formOrder {
		action, _ := attr(form, attrSend)
		errs = append(errs, fmt.Sprintf("The form data-pk-send=%q has fields without a name, which are not sent: give each field a name attribute (for example <input name=\"title\">). Unnamed: %s.", action, strings.Join(p.unnamed[form], ", ")))
	}
	errs = append(errs, p.sendErrors...)
	for _, name := range p.regionOrder {
		if n := p.regions[name]; n > 1 {
			errs = append(errs, fmt.Sprintf("Region %q is used %d times: region names must be unique — rename one, or remove the duplicate.", name, n))
		}
	}
	if p.emptySend {
		errs = append(errs, `data-pk-send needs an action name, for example data-pk-send="save".`)
	}
	if p.emptyRegion {
		errs = append(errs, `data-pk-region needs a name, for example data-pk-region="results".`)
	}

	hosts := p.hosts
	fixed, colours := false, 0
	var wide []string
	addWide := func(v float64) {
		if width > 0 && v > float64(width) {
			if s := strconv.FormatFloat(v, 'f', -1, 64) + "px"; !slices.Contains(wide, s) {
				wide = append(wide, s)
			}
		}
	}
	for _, sheet := range p.css {
		for _, u := range cssURLs(sheet) {
			hosts = appendHost(hosts, u)
		}
		// A url() is no declaration's text: its #fragment is not a colour, and
		// a data: URL's own ; would cut the declaration short.
		sheet = stripCalls(sheet, cssURLCall)
		for _, d := range declarations(sheet) {
			if d.property == "position" {
				fixed = fixed || cssFixed.MatchString(d.value)
			}
			// A var() is left out whole: a literal there is a fallback to the
			// theme.
			colours += len(cssColor.FindAllStringIndex(stripCalls(d.value, cssVarCall), -1))
		}
		// A width under a media or container query applies only where the
		// query says it fits; an @import's query is no width at all.
		for _, d := range declarations(stripConditional(cssImportRule.ReplaceAllString(sheet, ""))) {
			if d.property == "width" || d.property == "min-width" {
				if m := cssPixels.FindStringSubmatch(d.value); m != nil {
					v, _ := strconv.ParseFloat(m[1], 64)
					addWide(v)
				}
			}
		}
	}
	for _, v := range p.widthAttrs {
		addWide(v)
	}

	if len(hosts) > 0 {
		warns = append(warns, warning{kind: "hosts", items: hosts, text: fmt.Sprintf("Loads from %s: the user must allow each host before it loads, and until then it is missing. Prefer project files or inline code.", strings.Join(hosts, ", "))})
	}
	if slices.ContainsFunc(p.scripts, dialogCall.MatchString) {
		warns = append(warns, warning{kind: "dialogs", text: "alert/confirm/prompt do nothing here: show the message in the page instead."})
	}
	if fixed {
		warns = append(warns, warning{kind: "fixed", text: "position: fixed may put content off screen on a small device, and the canvas scrolls: prefer normal flow."})
	}
	if len(wide) > 0 {
		warns = append(warns, warning{kind: "widths", items: wide, text: fmt.Sprintf("Fixed widths wider than the canvas (%dpx): %s. The user will have to scroll sideways; use max-width or percentages.", width, strings.Join(wide, ", "))})
	}
	if colours > 0 {
		warns = append(warns, warning{kind: "colours", count: colours, text: fmt.Sprintf("%s not follow the user's light/dark theme. Use the --pk-* variables (for example color: var(--pk-text)).", plural(colours, "hard-coded colour: it will", "hard-coded colours: they will"))})
	}
	var unsent []string
	if !p.scriptSends() {
		unsent = p.unsent
	}
	unsent = append(unsent, p.files...)
	if len(unsent) > 0 {
		// Counted too: unnamed fields without an id all read "input".
		warns = append(warns, warning{kind: "unsent", items: unsent, count: len(unsent), text: fmt.Sprintf("%s never be sent: %s. Put %s in a form with data-pk-send, or send %[3]s from a script with pockode.send.", plural(len(unsent), "field can", "fields can"), strings.Join(unsent, ", "), pronoun(len(unsent)))})
	}
	return errs, warns
}

// scriptSends is whether a script may send: one that mentions pockode, or
// one loaded from a file the server does not read.
//
// Any mention of pockode counts, not only the text pockode.send: a script may
// reach it as pockode?.send or through const { send } = pockode, and an error
// it cannot see the reason for would only confuse the agent. An inline module
// importing another file is as unreadable as a script from one.
func (p *page) scriptSends() bool {
	return p.scriptSrc || slices.ContainsFunc(p.scripts, func(s string) bool {
		return pockodeRef.MatchString(s) || scriptImport.MatchString(s)
	})
}

func collect(doc *html.Node) *page {
	p := &page{
		regions:   map[string]int{},
		unnamed:   map[*html.Node][]string{},
		formsByID: map[string]*html.Node{},
		sending:   map[*html.Node]bool{},
	}
	// Forms first: a field's form="id" may name a form further down.
	walk(doc, func(n *html.Node) bool {
		if n.Namespace != "" {
			return true
		}
		_, send := attr(n, attrSend)
		if n.Data == "form" {
			if id, _ := attr(n, "id"); id != "" && p.formsByID[id] == nil {
				p.formsByID[id] = n
			}
			if send {
				p.sending[n] = true
			}
		} else if send && !isControl(n) && !inTemplate(n) {
			if form := ancestorForm(n); form != nil {
				p.sending[form] = true
			}
		}
		return true
	})
	walk(doc, func(n *html.Node) bool {
		p.element(n)
		return true
	})
	return p
}

func (p *page) element(n *html.Node) {
	if n.Namespace == "" && n.Data == "body" {
		p.bodyContent = hasContent(n)
	}
	for _, a := range n.Attr {
		key := a.Key
		switch {
		case a.Namespace == "" && key == attrSend:
			p.sends++
			if a.Val == "" {
				p.emptySend = true
			}
		case a.Namespace == "" && key == attrRegion && !inTemplate(n):
			if a.Val == "" {
				p.emptyRegion = true
			} else {
				if p.regions[a.Val] == 0 {
					p.regionOrder = append(p.regionOrder, a.Val)
				}
				p.regions[a.Val]++
			}
		case key == "style":
			p.css = append(p.css, cssComment.ReplaceAllString(a.Val, ""))
		case len(key) > 2 && strings.HasPrefix(key, "on"):
			p.scripts = append(p.scripts, a.Val)
		}
		if a.Namespace == "" && key == "srcset" {
			for _, candidate := range strings.Split(a.Val, ",") {
				if f := strings.Fields(candidate); len(f) > 0 {
					p.hosts = appendHost(p.hosts, f[0])
				}
			}
		}
		if loadsAttr(n, key) {
			p.hosts = appendHost(p.hosts, a.Val)
		}
		// Any attribute, not only href: a form's action or a button's
		// formaction runs it too.
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(a.Val)), "javascript:") {
			p.scripts = append(p.scripts, a.Val)
		}
	}

	switch n.Data {
	case "script":
		if slices.ContainsFunc(n.Attr, func(a html.Attribute) bool {
			// An svg script names its file with href or xlink:href.
			return a.Key == "src" || n.Namespace == "svg" && a.Key == "href"
		}) {
			p.scriptSrc = true
		} else {
			p.scripts = append(p.scripts, text(n))
		}
	case "style":
		p.css = append(p.css, cssComment.ReplaceAllString(text(n), ""))
	}

	if n.Namespace == "" {
		p.widthAttr(n)
		if isControl(n) {
			p.control(n)
		}
	} else if n.Namespace == "svg" && n.Data == "svg" && n.Parent != nil && n.Parent.Namespace != "svg" {
		// Inner SVG widths are in the outer svg's user units, not pixels.
		p.widthAttr(n)
	}
}

func (p *page) control(n *html.Node) {
	// A template's fields are inert until a script clones them, and that
	// script may well name them.
	if inTemplate(n) {
		return
	}
	typ := ""
	if n.Data == "input" {
		typ = inputType(n)
	}
	if action, own := attr(n, attrSend); own {
		switch {
		case n.Data == "select" || n.Data == "textarea":
			p.sendErrors = append(p.sendErrors, fmt.Sprintf("<%s data-pk-send=%q> cannot send by itself: put it in a form with data-pk-send and a submit button.", n.Data, action))
		case nonTextInputs[typ]:
			p.sendErrors = append(p.sendErrors, fmt.Sprintf("<input type=%q data-pk-send=%q> cannot be sent with Enter: put it in a form with data-pk-send and a submit button, or use a text input.", typ, action))
		}
		return
	}
	// A field with a handler of its own — a filter, a toggle, a file read
	// by a script — is one the page itself acts on, sent or not.
	if buttonInputs[typ] || typ == "hidden" || hasHandler(n) {
		return
	}
	if typ == "file" {
		p.files = append(p.files, describe(n))
		return
	}

	form := p.owner(n)
	if !p.sending[form] {
		p.unsent = append(p.unsent, describe(n))
		return
	}
	// A disabled field is not sent with or without a name, so it is no
	// mistake to leave it without one.
	if name, _ := attr(n, "name"); name != "" || disabled(n) {
		return
	}
	if _, formSends := attr(form, attrSend); !formSends {
		// Sent by a button's own action, which the form-name error is not
		// about; the field still never arrives.
		p.unsent = append(p.unsent, describe(n))
		return
	}
	if p.unnamed[form] == nil {
		p.formOrder = append(p.formOrder, form)
	}
	p.unnamed[form] = append(p.unnamed[form], describe(n))
}

// owner is the form a field belongs to: the one its form attribute names, or
// else the one around it. A form attribute naming no form leaves it with
// none, as in the browser.
func (p *page) owner(n *html.Node) *html.Node {
	if id, ok := attr(n, "form"); ok {
		return p.formsByID[id]
	}
	return ancestorForm(n)
}

// widthAttr records a width attribute, unless the element's own style sizes
// it: <canvas width="1170" style="width: 100%"> is a high-DPI canvas, drawn at
// the style's width.
func (p *page) widthAttr(n *html.Node) {
	v, ok := attr(n, "width")
	if !ok {
		return
	}
	style, _ := attr(n, "style")
	if slices.ContainsFunc(declarations(style), func(d declaration) bool {
		return d.property == "width"
	}) {
		return
	}
	v = strings.TrimSuffix(strings.TrimSpace(v), "px")
	if f, err := strconv.ParseFloat(v, 64); err == nil {
		p.widthAttrs = append(p.widthAttrs, f)
	}
}

// buttonInputs are the input types that are buttons, not fields.
var buttonInputs = map[string]bool{"submit": true, "button": true, "reset": true, "image": true}

// nonTextInputs are the types that hold no text to send on Enter. An unknown
// type is a text input to the browser, so it is not listed.
var nonTextInputs = map[string]bool{
	"checkbox": true, "radio": true, "file": true, "hidden": true, "range": true, "color": true,
	"date": true, "datetime-local": true, "month": true, "time": true, "week": true,
	"submit": true, "button": true, "reset": true, "image": true,
}

func inputType(n *html.Node) string {
	t, _ := attr(n, "type")
	return strings.ToLower(strings.TrimSpace(t))
}

func isControl(n *html.Node) bool {
	return n.Namespace == "" && (n.Data == "input" || n.Data == "select" || n.Data == "textarea")
}

func ancestorForm(n *html.Node) *html.Node {
	for a := n.Parent; a != nil; a = a.Parent {
		if a.Type == html.ElementNode && a.Namespace == "" && a.Data == "form" {
			return a
		}
	}
	return nil
}

func hasHandler(n *html.Node) bool {
	return slices.ContainsFunc(n.Attr, func(a html.Attribute) bool {
		return len(a.Key) > 2 && strings.HasPrefix(a.Key, "on")
	})
}

func inTemplate(n *html.Node) bool {
	for a := n.Parent; a != nil; a = a.Parent {
		if isTemplate(a) {
			return true
		}
	}
	return false
}

// disabled is whether n or a fieldset around it is disabled. A field in the
// fieldset's first legend is in fact enabled; counting it disabled only
// spares it an error.
func disabled(n *html.Node) bool {
	for a := n; a != nil; a = a.Parent {
		if a.Type == html.ElementNode && a.Namespace == "" && (a == n || a.Data == "fieldset") {
			if _, ok := attr(a, "disabled"); ok {
				return true
			}
		}
	}
	return false
}

// describe names an element for a list the agent can find it by.
func describe(n *html.Node) string {
	if id, _ := attr(n, "id"); id != "" {
		return n.Data + "#" + id
	}
	if name, _ := attr(n, "name"); name != "" {
		return fmt.Sprintf("%s[name=%q]", n.Data, name)
	}
	if t := inputType(n); t != "" && n.Data == "input" {
		return fmt.Sprintf("input[type=%q]", t)
	}
	return n.Data
}

func hasContent(n *html.Node) bool {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		switch c.Type {
		case html.ElementNode:
			return true
		case html.TextNode:
			if strings.TrimSpace(c.Data) != "" {
				return true
			}
		}
	}
	return false
}

func text(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			b.WriteString(c.Data)
		}
	}
	return b.String()
}

// loadsAttr is whether the attribute makes the browser fetch its URL. A
// link's href does not: following it is the user's click, which the app
// handles as a link. A <base href> is counted, since every relative load
// then goes to its host.
func loadsAttr(n *html.Node, key string) bool {
	switch key {
	case "src", "poster":
		return true
	case "href":
		return n.Data != "a" && n.Data != "area"
	}
	return false
}

// appendHost adds the host u names, when it names one beyond the page.
func appendHost(hosts []string, u string) []string {
	u = strings.TrimSpace(u)
	lower := strings.ToLower(u)
	if !strings.HasPrefix(lower, "http:") && !strings.HasPrefix(lower, "https:") && !strings.HasPrefix(lower, "//") {
		return hosts
	}
	parsed, err := url.Parse(u)
	if err != nil || parsed.Host == "" {
		return hosts
	}
	host := strings.ToLower(parsed.Host)
	if slices.Contains(hosts, host) {
		return hosts
	}
	return append(hosts, host)
}

var (
	cssComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	cssURL     = regexp.MustCompile(`(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)`)
	cssImport  = regexp.MustCompile(`(?i)@import\s+(?:"([^"]*)"|'([^']*)')`)
	// A declaration, not a selector or an at-rule's prelude such as
	// @media (min-width: 900px): its value runs to ; or } (or the end of a
	// style attribute), never into a {.
	cssDeclaration = regexp.MustCompile(`([\w-]+)\s*:([^;{}]*)(?:[;}]|$)`)
	cssFixed       = regexp.MustCompile(`(?i)^\s*fixed\b`)
	cssPixels      = regexp.MustCompile(`(?i)^\s*(\d+(?:\.\d+)?)px\b`)
	cssColor       = regexp.MustCompile(`(?i)#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(`)
	cssVarCall     = regexp.MustCompile(`(?i)\bvar\(`)
	cssURLCall     = regexp.MustCompile(`(?i)\burl\(`)
	cssConditional = regexp.MustCompile(`(?i)@(?:media|container)\b[^{;]*\{`)
	cssImportRule  = regexp.MustCompile(`(?i)@import\b[^;]*;?`)
	pockodeRef     = regexp.MustCompile(`\bpockode\b`)
	// import "x", import(…), import {…}, import * as, import name: not a word
	// that only starts with import.
	scriptImport = regexp.MustCompile(`\bimport(?:\s*[("'{*]|\s+[\w$])`)
	// The global function, not a method of the same name: obj.confirm(…).
	dialogCall = regexp.MustCompile(`(?:^|[^\w.$]|\b(?:window|self|globalThis)\.)(?:alert|confirm|prompt)\s*\(`)
)

func cssURLs(css string) []string {
	var urls []string
	for _, re := range []*regexp.Regexp{cssURL, cssImport} {
		for _, m := range re.FindAllStringSubmatch(css, -1) {
			urls = append(urls, m[1]+m[2]+m[len(m)-1])
		}
	}
	return urls
}

type declaration struct{ property, value string }

func declarations(css string) []declaration {
	var out []declaration
	for _, m := range cssDeclaration.FindAllStringSubmatch(css, -1) {
		out = append(out, declaration{strings.ToLower(m[1]), m[2]})
	}
	return out
}

// stripConditional removes every @media and @container block, nested blocks
// included.
func stripConditional(css string) string {
	var b strings.Builder
	for {
		loc := cssConditional.FindStringIndex(css)
		if loc == nil {
			b.WriteString(css)
			return b.String()
		}
		b.WriteString(css[:loc[0]])
		depth, j := 1, loc[1]
		for ; j < len(css) && depth > 0; j++ {
			switch css[j] {
			case '{':
				depth++
			case '}':
				depth--
			}
		}
		css = css[j:]
	}
}

// stripCalls removes every call open matches the start of, nested
// parentheses included.
func stripCalls(s string, open *regexp.Regexp) string {
	var b strings.Builder
	for {
		loc := open.FindStringIndex(s)
		if loc == nil {
			b.WriteString(s)
			return b.String()
		}
		b.WriteString(s[:loc[0]])
		depth, j := 1, loc[1]
		for ; j < len(s) && depth > 0; j++ {
			switch s[j] {
			case '(':
				depth++
			case ')':
				depth--
			}
		}
		s = s[j:]
	}
}
