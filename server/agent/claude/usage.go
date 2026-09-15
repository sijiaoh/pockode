package claude

import (
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// usageObserver reads the token, cost and context-window figures out of the
// stream and feeds them to the accumulator.
//
// It sits beside the parser rather than inside it (streamOutput calls both, the
// way it already does for the resume-state observer): what a turn cost is state
// the session store owns, not an entry in the transcript, and everything the
// parser returns is persisted into history and broadcast to chat clients.
//
// Where the numbers come from, on claude 2.1.263:
//
//   - `result.modelUsage` — a map of model id to that model's totals since the
//     CLI started, plus the model's `contextWindow`. Preferred over the frame's
//     own `usage` because `usage` reports the main model only: a turn that also
//     spent tokens on a side model (haiku writes the session title) has them in
//     modelUsage and nowhere else, so counting `usage` alone silently undercounts.
//   - `result.total_cost_usd` — the cost of those same totals, as Claude itself
//     accounts for it. The only cost figure Pockode ever stores.
//   - the last `assistant` frame's `message.usage` — how large the conversation
//     currently is: input + cache read + cache creation is the prompt of the last
//     API request the turn made, which is the only figure in the stream that is a
//     level rather than a total.
//
// `result.usage` is deliberately not used for the context reading, though it
// looks like it would be. Measured on claude 2.1.263: a turn that made 7 requests
// reported per-request cache reads of 18534, 23726, 23935, 24055, 24175, 24295
// and 24415, and `result.usage.cache_read_input_tokens` of 163135 — their sum. It
// is the whole turn added up, so reading it as a context level multiplies the
// answer by the number of requests the turn happened to make, which is how a
// session reached 904% of its window. It also cannot fall: the sum of a turn's
// requests has nothing to do with how much of the window is left.
//
// `system compact_boundary` carries `compact_metadata.post_tokens`, which looks
// like a ready-made post-compaction level and is not one: in the same run
// `pre_tokens` was 66631 against a measured prompt of 66200 (system prompt and
// tool definitions included) while `post_tokens` was 3026 against a next-request
// prompt of 24876 — it counts the retained conversation alone. Mixing the two
// would make the reading collapse and then jump back. The next assistant frame
// reports the drop on its own.
type usageObserver struct {
	log         *slog.Logger
	accumulator *agent.UsageAccumulator
	// model is the model id the last `system init` frame named. The CLI re-emits
	// init at the start of every turn, so this follows a model switched mid-session.
	model string
	// contextTokens is the prompt size of the most recent main-conversation
	// assistant frame. Kept across turns rather than cleared at each result,
	// because it is the last measurement there is: a turn that ran no request of
	// its own (`/compact` is one) has not made the conversation any smaller.
	contextTokens int64
	// warnedNoModelUsage keeps the "this CLI reports no modelUsage" warning to one
	// per process instead of one per turn.
	warnedNoModelUsage bool
}

func newUsageObserver(log *slog.Logger, opts agent.StartOptions) *usageObserver {
	return &usageObserver{log: log, accumulator: agent.NewUsageAccumulator(log, opts)}
}

// resultUsage is the usage half of a result frame, decoded separately from
// resultEvent: the two are read by different concerns and share no fields.
type resultUsage struct {
	ModelUsage   map[string]modelUsage `json:"modelUsage"`
	TotalCostUSD *float64              `json:"total_cost_usd"`
}

// assistantUsage is the usage half of an assistant frame: one API request's own
// figures, in the shape the Anthropic API reports them.
type assistantUsage struct {
	// ParentToolUseID names the tool call an assistant frame belongs to, and is
	// set on every frame a subagent produced. A subagent is prompted with its own
	// conversation — 11800 tokens against the main conversation's 24034 in the run
	// this was checked on — so its prompt size says nothing about how full this
	// session's window is.
	ParentToolUseID *string `json:"parent_tool_use_id"`
	Message         struct {
		Usage struct {
			InputTokens              int64 `json:"input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

type modelUsage struct {
	InputTokens              int64  `json:"inputTokens"`
	OutputTokens             int64  `json:"outputTokens"`
	CacheReadInputTokens     int64  `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64  `json:"cacheCreationInputTokens"`
	ContextWindow            int64  `json:"contextWindow"`
	CanonicalModel           string `json:"canonicalModel"`
}

// observe is called for every decoded line, and reacts to the three frames that
// carry usage data.
func (o *usageObserver) observe(line []byte, event cliEvent) {
	switch {
	case event.Type == "system" && event.Subtype == "init":
		o.observeInit(line)
	case event.Type == "assistant":
		o.observeAssistant(line)
	case event.Type == "result":
		o.observeResult(line)
	}
}

func (o *usageObserver) observeInit(line []byte) {
	var init struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(line, &init); err != nil {
		// Nothing to report and nothing to recover: the next init says the same
		// thing, and until then contextWindow falls back to the widest model.
		o.log.Debug("failed to read model from init frame", "error", err)
		return
	}
	o.model = init.Model
}

// observeAssistant records how large the prompt of one API request was. The last
// one to arrive before a result frame is the conversation's current size.
func (o *usageObserver) observeAssistant(line []byte) {
	var frame assistantUsage
	if err := json.Unmarshal(line, &frame); err != nil {
		// The parser reports the same frame to the user, so a broken one is already
		// visible; here it only means the context reading keeps its last value.
		o.log.Debug("failed to read usage from assistant frame", "error", err)
		return
	}
	if frame.ParentToolUseID != nil {
		return
	}

	tokens := frame.Message.Usage.InputTokens +
		frame.Message.Usage.CacheReadInputTokens +
		frame.Message.Usage.CacheCreationInputTokens
	// A frame reporting no usage measured nothing, so it must not overwrite what
	// the last frame that did measure something said.
	if tokens > 0 {
		o.contextTokens = tokens
	}
}

func (o *usageObserver) observeResult(line []byte) {
	var result resultUsage
	if err := json.Unmarshal(line, &result); err != nil {
		o.log.Warn("failed to read usage from result frame", "error", err)
		return
	}

	if len(result.ModelUsage) == 0 {
		// No per-model totals means no cumulative figures to take deltas from, and
		// the frame's own `usage` cannot stand in: it is this turn's increment, so
		// mixing the two would double count every turn once modelUsage reappeared.
		// Nothing is recorded, and the user is told why rather than quietly seeing
		// a session that consumed nothing.
		if !o.warnedNoModelUsage {
			o.warnedNoModelUsage = true
			o.log.Warn("claude CLI reports no per-model usage, token usage will not be recorded for this session")
		}
		return
	}

	var total session.TokenUsage
	for _, mu := range result.ModelUsage {
		total = total.Add(session.TokenUsage{
			InputTokens:      mu.InputTokens,
			OutputTokens:     mu.OutputTokens,
			CacheReadTokens:  mu.CacheReadInputTokens,
			CacheWriteTokens: mu.CacheCreationInputTokens,
		})
	}

	o.accumulator.Report(total, result.TotalCostUSD, o.contextTokens, o.contextWindow(result.ModelUsage))
}

// contextWindow picks the window of the model the session is running, which is
// the only one the context reading means anything against: side models are
// prompted separately and their window has nothing to do with how full this
// conversation is.
//
// Matching is by the id init reported, which is the same id modelUsage is keyed
// by (both come from the CLI's own model resolution), then by canonical model for
// the case where one carries a variant suffix — `claude-opus-5[1m]` and
// `claude-opus-5` are the same model with different windows, and a resumed
// process reports the plain form. A model that matches neither leaves the widest
// reported window, which is the main model in every arrangement seen: the side
// models Claude prompts on its own are the small ones.
//
// Both fallbacks take the widest of the candidates rather than the first one
// found, because ranging over a map hands them over in a different order every
// time: a process that used both `claude-opus-5[1m]` and `claude-opus-5` reports
// two entries with the same canonical model and different windows, and picking
// whichever came first would make the context reading jump between turns that
// reported exactly the same thing.
func (o *usageObserver) contextWindow(modelUsage map[string]modelUsage) int64 {
	if mu, ok := modelUsage[o.model]; ok {
		return mu.ContextWindow
	}

	canonical := o.model
	if i := strings.IndexByte(canonical, '['); i > 0 {
		canonical = canonical[:i]
	}

	var widestCanonical, widest int64
	for _, mu := range modelUsage {
		if mu.ContextWindow > widest {
			widest = mu.ContextWindow
		}
		if canonical != "" && mu.CanonicalModel == canonical && mu.ContextWindow > widestCanonical {
			widestCanonical = mu.ContextWindow
		}
	}
	if widestCanonical > 0 {
		return widestCanonical
	}
	return widest
}
