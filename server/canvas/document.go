package canvas

import (
	"bytes"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/net/html"
)

// MaxDocumentBytes bounds both a render's html and the document an update
// produces: every revision is kept as a full snapshot, so the cap is on what
// the session's storage and every redraw can afford (docs/canvas-ui.md §3.1).
const MaxDocumentBytes = 256 * 1024

const (
	attrSend   = "data-pk-send"
	attrRegion = "data-pk-region"
)

// Page is a document that passed lint, serialized as it is to be stored and
// drawn.
type Page struct {
	HTML     string
	Warnings []string
}

// Rejection is a call refused with the canvas left unchanged. Each problem is
// one sentence naming what is wrong and how to fix it, for the agent to read.
type Rejection struct {
	Problems []string
}

func (r *Rejection) Error() string {
	return strings.Join(r.Problems, "\n")
}

func reject(problems ...string) *Rejection {
	return &Rejection{Problems: problems}
}

// CheckRender normalizes and lints a canvas_render's html. width is the canvas
// width the page is drawn for, 0 when no size has been reported yet.
func CheckRender(src string, width int) (Page, error) {
	if strings.TrimSpace(src) == "" {
		return Page{}, reject(msgEmpty)
	}
	if len(src) > MaxDocumentBytes {
		return Page{}, reject(msgTooLarge(len(src)))
	}
	doc, err := parse(src)
	if err != nil {
		return Page{}, err
	}
	out, warns, err := finish(doc, width)
	if err != nil {
		return Page{}, err
	}
	return Page{HTML: out, Warnings: texts(warns)}, nil
}

// ApplyUpdate applies ops in order to current, the stored document of the
// latest revision ("" when nothing is drawn yet), and lints the result. All or
// nothing: on any problem the error is a *Rejection and current stands. The
// warnings returned are only those current did not already have.
func ApplyUpdate(current string, ops []Op, width int) (Page, error) {
	if current == "" {
		return Page{}, reject("There is no canvas yet: draw the whole page with canvas_render first.")
	}
	if len(ops) == 0 {
		return Page{}, reject("ops is empty: pass at least one op (replace, append or remove).")
	}
	if problems := validateOps(ops); len(problems) > 0 {
		return Page{}, reject(problems...)
	}

	doc, err := html.Parse(strings.NewReader(current))
	if err != nil {
		// finish read every stored document back before it was stored.
		return Page{}, fmt.Errorf("parse stored canvas: %w", err)
	}
	_, before := lint(doc, len(current), width)

	var problems []string
	for i, op := range ops {
		if p, err := applyOp(doc, i, op); err != nil {
			return Page{}, err
		} else if p != "" {
			// Later ops still run, so every missing region is reported in one
			// call; the tree is discarded anyway.
			problems = append(problems, p)
		}
	}
	if len(problems) > 0 {
		return Page{}, reject(problems...)
	}

	out, warns, err := finish(doc, width)
	if err != nil {
		return Page{}, err
	}
	var added []string
	for _, w := range warns {
		if w.grewFrom(before) {
			added = append(added, w.text)
		}
	}
	return Page{HTML: out, Warnings: added}, nil
}

// finish serializes the tree a call produced and lints what was serialized,
// read back as every client and the next update will read it: a tree the
// serializer cannot write faithfully (markup inside a raw-text element, an
// svg <style> holding elements) comes back different, and the stored text is
// the one that has to be right.
func finish(doc *html.Node, width int) (string, []warning, error) {
	if tag := voidWithContents(doc); tag != "" {
		// Nothing can be serialized; the size is the one check left out.
		errs, _ := lint(doc, 0, width)
		msg := fmt.Sprintf("<%s> cannot hold anything, but the page puts content inside one: it has no closing tag, so put that content after it, or use another element.", tag)
		return "", nil, reject(append([]string{msg}, errs...)...)
	}
	out, err := serialize(doc)
	if err != nil {
		return "", nil, err
	}
	stored, err := parse(out)
	if err != nil {
		return "", nil, err
	}
	errs, warns := lint(stored, len(out), width)
	if lost := lostRegions(doc, stored); len(lost) > 0 {
		errs = append(errs, fmt.Sprintf("The page does not read back as written: regions %s are lost, because something before them — markup inside a <script>, <style> or <svg>, or a <plaintext> — swallows the rest. Check what this call puts there.", strings.Join(lost, ", ")))
	}
	if len(errs) > 0 {
		return "", nil, reject(errs...)
	}
	return out, warns, nil
}

// parse refuses a page nested deeper than x/net/html takes; any other parse
// error is the parser's own.
func parse(src string) (*html.Node, error) {
	doc, err := html.Parse(strings.NewReader(src))
	if tooDeep(err) {
		return nil, reject(msgTooDeep)
	}
	if err != nil {
		return nil, fmt.Errorf("parse canvas: %w", err)
	}
	return doc, nil
}

// tooDeep recognizes x/net/html's nesting limit by its text, the only form
// it is reported in: the parser panics with it and recovers into an error.
func tooDeep(err error) bool {
	return err != nil && strings.Contains(err.Error(), "open stack of elements exceeds 512")
}

const msgTooDeep = "The page nests elements more than 512 deep, which cannot be read: flatten it, or build deep structures from a script."

func lostRegions(written, stored *html.Node) []string {
	kept := regionNames(stored)
	var lost []string
	for _, name := range regionNames(written) {
		if !slices.Contains(kept, name) {
			lost = append(lost, name)
		}
	}
	return lost
}

func validateOps(ops []Op) []string {
	var problems []string
	for i, op := range ops {
		switch op.Op {
		case OpReplace, OpAppend:
			if op.HTML == nil || op.Op == OpAppend && *op.HTML == "" {
				problems = append(problems, fmt.Sprintf("ops[%d]: %s needs html", i, op.Op))
			} else if len(*op.HTML) > MaxDocumentBytes {
				// It could only make a page over the limit; not worth parsing.
				problems = append(problems, fmt.Sprintf("ops[%d]: %s", i, msgTooLarge(len(*op.HTML))))
			}
		case OpRemove:
			if op.HTML != nil {
				problems = append(problems, fmt.Sprintf("ops[%d]: remove takes no html", i))
			}
		default:
			problems = append(problems, fmt.Sprintf("ops[%d]: unknown op %q: use replace, append or remove", i, op.Op))
			continue
		}
		if op.Region == "" {
			problems = append(problems, fmt.Sprintf("ops[%d]: %s needs a region: the data-pk-region name of the element to change", i, op.Op))
		}
	}
	return problems
}

// applyOp returns a problem for the agent, or an error when the parser
// itself failed.
func applyOp(doc *html.Node, i int, op Op) (string, error) {
	region := findRegion(doc, op.Region)
	if region == nil {
		return msgMissingRegion(doc, op.Region), nil
	}
	if op.Op == OpRemove {
		region.Parent.RemoveChild(region)
		return "", nil
	}
	// The serializer refuses a void element with children, and a browser's
	// innerHTML on one draws nothing.
	if voidElements[region.Data] && *op.HTML != "" {
		return fmt.Sprintf("ops[%d]: region %q is an <%s>, which cannot hold contents: mark an element around it with data-pk-region instead, or replace the whole element through its parent region.", i, op.Region, region.Data), nil
	}
	nodes, problem, err := parseContents(region, i, op)
	if problem != "" || err != nil {
		return problem, err
	}
	if op.Op == OpReplace {
		for c := region.FirstChild; c != nil; c = region.FirstChild {
			region.RemoveChild(c)
		}
	}
	for _, n := range nodes {
		region.AppendChild(n)
	}
	return "", nil
}

// findRegion takes the first in document order, as the bridge's
// querySelector does: a stored document has no duplicates, but one op may
// create one that a later op of the same call removes.
func findRegion(doc *html.Node, name string) *html.Node {
	var found *html.Node
	walk(doc, func(n *html.Node) bool {
		if found != nil {
			return false
		}
		if v, ok := attr(n, attrRegion); ok && v == name {
			found = n
			return false
		}
		return !isTemplate(n)
	})
	return found
}

func regionNames(doc *html.Node) []string {
	var names []string
	seen := map[string]bool{}
	walk(doc, func(n *html.Node) bool {
		if v, ok := attr(n, attrRegion); ok && v != "" && !seen[v] {
			seen[v] = true
			names = append(names, v)
		}
		return !isTemplate(n)
	})
	return names
}

// isTemplate is whether n is a <template>, whose contents the parser here
// keeps as children but a browser keeps in a fragment of their own, which
// querySelector never searches. So a region inside one is no region of the
// page: the bridge could not find it to patch (docs/canvas-ui.md §3.2).
func isTemplate(n *html.Node) bool {
	return n.Type == html.ElementNode && n.Namespace == "" && n.Data == "template"
}

func serialize(doc *html.Node) (string, error) {
	var buf bytes.Buffer
	if err := html.Render(&buf, doc); err != nil {
		return "", fmt.Errorf("serialize canvas: %w", err)
	}
	return buf.String(), nil
}

// voidElements are those html.Render refuses to give children.
var voidElements = map[string]bool{
	"area": true, "base": true, "br": true, "col": true, "embed": true, "hr": true, "img": true,
	"input": true, "keygen": true, "link": true, "meta": true, "param": true, "source": true,
	"track": true, "wbr": true,
}

// voidWithContents names an element the serializer would refuse to write. It
// goes by the name alone, as html.Render does: foreign content such as
// <svg><track><rect/></track></svg> can parse into one.
func voidWithContents(doc *html.Node) string {
	tag := ""
	walk(doc, func(n *html.Node) bool {
		if tag == "" && voidElements[n.Data] && n.FirstChild != nil {
			tag = n.Data
		}
		return tag == ""
	})
	return tag
}

// rawText are the elements whose contents the browser takes as text, with no
// markup; escapable are those that still decode character references.
var (
	rawText   = map[string]bool{"script": true, "style": true, "xmp": true, "iframe": true, "noembed": true, "noframes": true, "noscript": true, "plaintext": true}
	escapable = map[string]bool{"textarea": true, "title": true}
)

// parseContents parses op's html as the region's innerHTML would. For a
// raw-text region that is one text node: x/net/html lets the region's own end
// tag close it, where innerHTML keeps everything as text.
func parseContents(region *html.Node, i int, op Op) ([]*html.Node, string, error) {
	src := *op.HTML
	if region.Namespace == "" && (rawText[region.Data] || escapable[region.Data]) {
		if src == "" {
			return nil, "", nil
		}
		if rawText[region.Data] {
			// What the region holds afterwards is what the next parse reads,
			// so an append is checked together with the text already there.
			result := src
			if op.Op == OpAppend {
				result = text(region) + src
			}
			if p := rawTextProblem(region.Data, strings.ToLower(result)); p != "" {
				return nil, fmt.Sprintf("ops[%d]: <%s> region %q would contain %s", i, region.Data, op.Region, p), nil
			}
		} else {
			src = html.UnescapeString(src)
		}
		return []*html.Node{{Type: html.TextNode, Data: src}}, "", nil
	}
	nodes, err := html.ParseFragment(strings.NewReader(src), region)
	if tooDeep(err) {
		return nil, fmt.Sprintf("ops[%d]: %s", i, msgTooDeep), nil
	}
	if err != nil {
		return nil, "", fmt.Errorf("parse ops[%d] html: %w", i, err)
	}
	return nodes, "", nil
}

// rawTextProblem is what in the text of a raw-text element of tag (lower
// cased) would end it early when the page is parsed again, or "".
func rawTextProblem(tag, text string) string {
	if strings.Contains(text, "</"+tag) {
		return fmt.Sprintf("\"</%s\", which would end the element when the page is drawn: write it as \"<\\/%s\" instead.", tag, tag)
	}
	if tag != "script" {
		return ""
	}
	// The tokenizer's script-data escape states: <!-- escapes, and <script
	// inside it double-escapes; --> leaves either. A </script would leave the
	// double escape, but is refused above. Text that ends double-escaped
	// makes the region's own </script> stop ending it, and the rest of the
	// page is read as script.
	for rest := text; ; {
		i := strings.Index(rest, "<!--")
		if i < 0 {
			return ""
		}
		// From the opener's own dashes: <!--> and <!---> close at once.
		rest = rest[i+2:]
		end := strings.Index(rest, "-->")
		open := scriptOpen.FindStringIndex(rest)
		if open == nil || end >= 0 && end < open[0] {
			if end < 0 {
				return ""
			}
			rest = rest[end+3:]
			continue
		}
		rest = rest[open[1]:]
		end = strings.Index(rest, "-->")
		if end < 0 {
			return "\"<script\" inside \"<!--\" with no \"-->\" after it, which makes the browser read the rest of the page as script: close it with \"-->\", or write \"<\\!--\" instead."
		}
		rest = rest[end+3:]
	}
}

// scriptOpen is <script as the tokenizer takes it for a tag name.
var scriptOpen = regexp.MustCompile(`<script[\t\n\f\r />]`)

// walk visits n and its descendants in document order; visit returning false
// skips the node's children.
func walk(n *html.Node, visit func(*html.Node) bool) {
	if n.Type == html.ElementNode || n.Type == html.DocumentNode {
		if n.Type == html.ElementNode && !visit(n) {
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, visit)
		}
	}
}

func attr(n *html.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if a.Namespace == "" && a.Key == key {
			return a.Val, true
		}
	}
	return "", false
}
