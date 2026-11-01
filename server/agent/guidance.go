package agent

// Guidance is what an agent has to know about Pockode's own tools before it has
// loaded any of them: when to reach for them, and what not to do in their place.
// How to call a tool stays in its description, which the agent reads once it
// goes for the tool.
//
// It cannot live in those descriptions alone. Both CLIs load MCP tools lazily,
// and until a model loads one it sees the name and not the description — so an
// agent that never thought of asking, or of rendering, never read why it
// should. Each CLI gets this text through the one channel it shows before
// loading:
//   - Claude: the MCP server's initialize instructions, which it puts in the
//     system prompt (mcp.Server). Codex shows those only once a tool from the
//     server is loaded, as the description of its namespace.
//   - Codex: the thread's developer instructions (codex startThread),
//     which are fixed when the thread starts: a thread started before this
//     text existed, or before a change to it, goes on without it.
//
// Claude cuts server instructions at 2048 characters, which this text has to
// stay under; mcp's TestToolDefinitions_FitClaudesLimit holds it there.
const Guidance = askingGuidance + "\n\n" + renderingGuidance

// askingGuidance: that a decision of the user's is asked with question_post,
// that a step's decisions are asked together, and what never to ask in the
// reply text.
const askingGuidance = "Asking the user something in Pockode:\n\n" +
	"- When you need a decision from the user, ask it with the question_post tool; load it through your tool search first if you only have its name. " +
	"It is the only way to ask here: your CLI's own ask-the-user tool does not reach the user.\n" +
	"- Ask only for a decision that belongs to the user and changes what you do next. " +
	"Do not ask what you can find out yourself — read the code, the docs and the history first. " +
	"Where a choice has a conventional default, take it and say so. " +
	"Do not ask for permission to act; the permission system handles that. " +
	"Do not ask \"shall I continue?\" or \"is this OK?\" — ask the decision itself.\n" +
	"- Ask the decisions a step needs from the user together, in one question_post call, as early as you can — not one now and the next later. " +
	"Only those, though: each question makes the user stop and think. " +
	"Each such decision is either asked or taken as a default you state: never ask one and quietly decide the rest yourself.\n" +
	"- Never put a question for the user in your reply text, least of all a multiple-choice one: it cannot be answered as a form there. " +
	"And do not act on the answer you expect before the user has given it.\n" +
	"- Never ask for passwords, tokens or API keys, in your reply or in a question: whatever the user answers is stored in the transcript and sent to the model. " +
	"Tell the user which environment variable or file to set instead."

// renderingGuidance: that html_render exists for what Markdown carries badly,
// that it can show project files, and that the reply does not repeat what it
// showed.
const renderingGuidance = "Showing the user something in Pockode:\n\n" +
	"- When a comparison, a chart or a structured report is shown better by something richer than Markdown, show it with the html_render tool; load it through your tool search first if you only have its name.\n" +
	"- A rendered page can show project files — screenshots, recordings, sounds, data — by path: reference them instead of inlining them.\n" +
	"- Do not repeat or summarize in your reply what you rendered: the user already sees it."

// CanvasGuidance replaces Guidance in a canvas session (docs/canvas-ui.md §9):
// a different session, not an addition, since Guidance's asking section points
// at question_post and its rendering section at html_render, neither of which a
// canvas session has. It reaches each CLI through the channel Guidance does,
// under the same 2048-character limit.
//
// The markup examples are here as well as in canvas_render's description on
// purpose: this text is read before any tool is loaded, and an agent that has
// not seen the markup plans its first page without it.
const CanvasGuidance = "This session is a Pockode canvas: the user's whole screen is a page you draw. Make it work by itself, not a report with buttons under it.\n\n" +
	"- Draw with canvas_render (the whole page) and canvas_update (replace, append or remove parts marked data-pk-region); load them through your tool search first if you only have their names.\n" +
	"- What the page can do itself never comes back to you: tabs, filters, sorting, expanding, editing are the page's own scripts. " +
	"The things on the page are the controls: a card or a row is a <button> unless it holds fields (a div or li with data-pk-send acts as one too), a field sits next to what it is about.\n" +
	"- Send only when you are needed: a decision that changes what you do next, or work only you can do. " +
	"Carry what a send is about with it: a button's name and value, hidden inputs in a form, or pockode.send(action, data).\n" +
	"- Draw what you need from the user into the page; do not ask in your reply text. " +
	"Never ask for passwords, tokens or API keys; tell the user which environment variable or file to set instead.\n" +
	"- Keep your reply text to short progress notes: the user sees only its latest line, beside the canvas. Never repeat what the canvas shows.\n" +
	"- Every message from the user ends with the size of their canvas. Design for the latest one; the canvas scrolls, so use normal flow and avoid position: fixed and 100vh.\n" +
	"- Do not draw permission confirmations: Pockode asks the user for permissions itself, outside your page.\n" +
	"- A send fired on page load fires again on every redraw, on every device showing it, each starting a turn: do it only on purpose.\n" +
	"- Change the regions that changed with canvas_update rather than redrawing everything, so what the user typed and the page's scripts changed elsewhere stays.\n" +
	"- Minimal examples: <button data-pk-send=\"open\" name=\"id\" value=\"42\">Open</button> · " +
	"<form data-pk-send=\"rename\"><input type=\"hidden\" name=\"id\" value=\"42\"><input name=\"title\"><button>Save</button></form> · " +
	"<input data-pk-send=\"search\" name=\"q\"> (Enter sends) · " +
	"<ul data-pk-region=\"results\"></ul>."

// GuidanceFor is the guidance a session gets: CanvasGuidance in a canvas
// session, Guidance in any other.
func GuidanceFor(canvas bool) string {
	if canvas {
		return CanvasGuidance
	}
	return Guidance
}
