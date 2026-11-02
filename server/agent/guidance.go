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
	"Do not ask what you can find out yourself — read the code, docs and history first. " +
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

// HTMLFirstGuidance replaces Guidance in an HTML-first session. The tools are
// the same in both, so it keeps the asking section as it is and swaps only the
// rendering one: Guidance's says when a page is worth it, this one makes the
// page the default for anything structured. It reaches each CLI through the
// channel Guidance does, under the same 2048-character limit.
const HTMLFirstGuidance = askingGuidance + "\n\n" + htmlFirstRenderingGuidance

// htmlFirstRenderingGuidance: that structured content goes on a page and the
// reply stays short, that the page works by itself, that a page is changed from
// the old one rather than redrawn, and what widths it is seen at — a
// recommendation, since content that is wide by nature may be drawn wide.
//
// A choice on a page and question_post do not compete: the page is for what the
// user explores and fills in, question_post still for the decision the agent
// waits on — said here because the asking section above it says "a decision"
// without that distinction.
const htmlFirstRenderingGuidance = "Showing the user something in this HTML-first Pockode session:\n\n" +
	"- Show anything structured — comparisons, reports, choices, forms — as an html_render page (load it, html_edit and html_get via tool search if you only have their names). " +
	"Reply in a sentence or two; never repeat the page.\n" +
	"- Make the page work by itself and send to you only when it needs you. Still ask a decision you wait on with question_post.\n" +
	"- Change a page with html_edit; html_get reads an old one.\n" +
	"- Pages show at ~320–1280px: prefer a fluid layout; draw what is wide by nature (big tables, timelines, diffs) wide; it scrolls sideways. Reference project files by path, not inlined."

// GuidanceFor is the guidance a session starts with: HTMLFirstGuidance in an
// HTML-first session, Guidance in any other.
func GuidanceFor(htmlFirst bool) string {
	if htmlFirst {
		return HTMLFirstGuidance
	}
	return Guidance
}
