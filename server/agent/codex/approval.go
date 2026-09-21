package codex

import (
	"encoding/json"
	"fmt"

	"github.com/pockode/server/agent"
)

// The decisions Codex accepts on a command or file-change approval. The other
// values its schema defines (acceptWithExecpolicyAmendment,
// applyNetworkPolicyAmendment) amend policy files rather than answer this one
// request, and Pockode has no surface that asks the user for that.
const (
	decisionAccept           = "accept"
	decisionAcceptForSession = "acceptForSession"
	// decisionDecline refuses; the agent keeps the turn and tries something else.
	decisionDecline = "decline"
	// decisionCancel refuses and ends the turn with it. Used only for an
	// interrupt, where ending the turn is the point.
	decisionCancel = "cancel"
)

// deniedByUser is what a refusal reads as in the transcript, so it has to read
// as an explanation rather than a status code.
const deniedByUser = "The user denied this request."

// handleServerRequest answers a request the CLI makes of us.
func (s *appSession) handleServerRequest(msg rpcMessage) {
	switch msg.Method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		go s.handleApproval(msg)

	case "item/permissions/requestApproval":
		// Only reachable under the `granular` approval policy, which Pockode
		// does not set (see buildThreadParams). Granting nothing is the refusal:
		// the reply's shape is the permissions handed over, not a decision.
		s.log.Warn("codex asked for a permission grant Pockode has no surface for; granting nothing",
			"params", string(msg.Params))
		s.sendRPCResponse(*msg.ID, map[string]interface{}{"permissions": map[string]interface{}{}}, nil)

	case "mcpServer/elicitation/request":
		// An MCP server asking the user to fill in a form. The one server
		// Pockode installs never does, so this can only come from a server the
		// user configured in Codex themselves — declining leaves that server's
		// call to fail with a refusal instead of hanging the turn forever.
		s.log.Warn("declining an MCP elicitation Pockode cannot show", "params", string(msg.Params))
		s.sendRPCResponse(*msg.ID, map[string]interface{}{"action": "decline"}, nil)

	case "item/tool/requestUserInput":
		s.handleRequestUserInput(msg)

	default:
		// Refusing a request is not free the way ignoring a notification is: the
		// CLI asked this session for something and gets an error back, which can
		// change what the turn does. Logged at warn so an approval shape upstream
		// starts sending — the protocol still defines the v1 `execCommandApproval`
		// and `applyPatchApproval` pair, which 0.153.0 does not send to us — shows
		// up as a line rather than as a turn that mysteriously gave up.
		s.log.Warn("refusing a server request Pockode does not implement", "method", msg.Method)
		s.sendRPCResponse(*msg.ID, nil, &rpcError{Code: -32601, Message: "method not found"})
	}
}

// approvalRequest is the part of an approval request Pockode reads. Which
// fields are present depends on the method: a file-change approval names only
// the item, and its patch comes from the item/started that preceded it.
type approvalRequest struct {
	ItemID string `json:"itemId"`
	// ApprovalID distinguishes several callbacks belonging to one item, which
	// the CLI uses for subcommand and stdin approvals. Null for ordinary ones.
	ApprovalID string `json:"approvalId"`
	Command    string `json:"command"`
	Cwd        string `json:"cwd"`
	// Kind tells a command apart from input sent to a terminal already running
	// ("writeStdin"). Absent means "command" on older servers.
	Kind string `json:"kind"`
	// Reason is the CLI's own explanation of why it is asking ("May I read
	// old.txt outside the sandbox to make your requested edit?"). Only read when
	// there is nothing better to show; see describeApproval.
	Reason string `json:"reason"`
}

// handleApproval asks the user, then answers Codex. It runs on its own
// goroutine: everything else the CLI has to say arrives while this waits.
func (s *appSession) handleApproval(msg rpcMessage) {
	var params approvalRequest
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		s.log.Warn("failed to parse approval request", "method", msg.Method, "error", err)
		// Deliberately not deniedByUser: nobody decided anything here, and this
		// is what the model gets told, so blaming the user for a request we
		// could not read would send it looking in the wrong place.
		s.sendRPCResponse(*msg.ID, approvalResult(decisionDecline), nil)
		return
	}

	// The id of the specific callback when there is one, so two approvals of the
	// same item cannot answer each other.
	requestID := firstNonEmpty(params.ApprovalID, params.ItemID)
	if requestID == "" {
		requestID = fmt.Sprintf("approval-%d", *msg.ID)
	}

	toolName, toolInput := s.describeApproval(msg.Method, params)

	ch := make(chan string, 1)
	if _, loaded := s.pendingApprovals.LoadOrStore(requestID, ch); loaded {
		// Two live approvals under one id: the second would replace the first in
		// the map, and the user's single answer would settle whichever is there
		// while the other waits for one that can never arrive — a turn stuck for
		// the life of the process. The CLI avoids this by sending an approvalId
		// wherever one item can raise several approvals, so reaching here means
		// that stopped being true.
		s.log.Error("two codex approvals share one request id; refusing the second", "requestId", requestID)
		s.sendRPCResponse(*msg.ID, approvalResult(decisionDecline), nil)
		return
	}

	// ToolUseID is the item being approved, so the prompt points at the same
	// call as the tool events around it.
	s.emitEvent(agent.PermissionRequestEvent{
		RequestID: requestID,
		ToolName:  toolName,
		ToolInput: toolInput,
		ToolUseID: params.ItemID,
	})

	var decision string
	select {
	case decision = <-ch:
	case <-s.procCtx.Done():
		// The process is going away; nothing is listening for this answer.
		s.pendingApprovals.Delete(requestID)
		return
	}

	s.pendingApprovals.Delete(requestID)
	s.sendRPCResponse(*msg.ID, approvalResult(decision), nil)
}

// describeApproval renders what is being approved, in the same shape as the
// tool call it belongs to so the prompt and the transcript row agree.
func (s *appSession) describeApproval(method string, params approvalRequest) (toolName string, toolInput json.RawMessage) {
	// The item's rendering is the one already on screen, so the prompt and the
	// transcript row agree whenever it is available. A file change has no other
	// source at all — its patch is not in the request — while a command approval
	// carries the command itself and can be described without it.
	if input, ok := s.toolInput(params.ItemID); ok {
		return toolNameOf(method), input
	}

	if method != "item/fileChange/requestApproval" && params.Command != "" {
		input, _ := json.Marshal(map[string]interface{}{
			"command": params.Command,
			"cwd":     params.Cwd,
		})
		return "Bash", input
	}

	// Nothing to show, and the user is being asked to approve it anyway. Two
	// shapes reach here: a file change whose item we never saw start, and
	// `kind: "writeStdin"` — input sent to a terminal already running — which has
	// no command of its own. The request's own explanation is then all there is,
	// and a prompt that says why it was raised beats one that says nothing.
	s.log.Warn("approval request describes nothing Pockode can render",
		"method", method, "kind", params.Kind, "itemId", params.ItemID)

	fallback := map[string]interface{}{}
	if params.Reason != "" {
		fallback["reason"] = params.Reason
	}
	if params.Kind != "" {
		fallback["kind"] = params.Kind
	}
	if len(fallback) == 0 {
		// `reason` is nullable, so "all there is" can be nothing at all. The
		// frontend summarises a request by its first non-empty string and hides
		// the body when every field is empty, so the empty fields would render
		// as a prompt with no question in it — still blocking the turn, still
		// demanding an answer. Saying that much is the least dishonest prompt
		// available.
		fallback["reason"] = "Codex asked for approval without saying what for. Deny if you are not expecting this."
	}
	input, _ := json.Marshal(fallback)
	return toolNameOf(method), input
}

// toolNameOf is the name the frontend renders this approval under: Pockode's
// own, matching the tool call the approval belongs to.
func toolNameOf(method string) string {
	if method == "item/fileChange/requestApproval" {
		return "Edit"
	}
	return "Bash"
}

// approvalResult builds the reply. Anything that is not an approval refuses, so
// a decision we do not recognise fails closed.
func approvalResult(decision string) map[string]interface{} {
	switch decision {
	case decisionAccept, decisionAcceptForSession, decisionCancel:
		return map[string]interface{}{"decision": decision}
	default:
		return map[string]interface{}{"decision": decisionDecline}
	}
}

// answerApproval hands a decision to the goroutine waiting on it.
func (s *appSession) answerApproval(requestID, decision string) {
	pending, ok := s.pendingApprovals.LoadAndDelete(requestID)
	if !ok {
		s.log.Debug("no pending codex approval for this response", "requestId", requestID)
		return
	}
	ch := pending.(chan string)
	select {
	case ch <- decision:
	default:
	}
}

// cancelPendingApprovals refuses every outstanding approval and withdraws its
// prompt from the UI. Called on interrupt, and again after the process exits as
// a safety net for prompts still on screen.
//
// `cancel` rather than `decline`: both refuse, but only cancel ends the turn,
// and a turn nobody wants to continue is exactly what an interrupt means.
func (s *appSession) cancelPendingApprovals() {
	s.pendingApprovals.Range(func(key, _ any) bool {
		requestID := key.(string)
		pending, ok := s.pendingApprovals.LoadAndDelete(requestID)
		if !ok {
			// Answered between the Range and here.
			return true
		}
		// Withdrawn before the decision is handed over, not after: the decision
		// is what lets the turn end, and a turn that ends first puts its
		// interrupted event in front of the withdrawal of a prompt the user can
		// still see. Deleted here as well, so a second sweep — interrupt, then
		// the one after the process exits — cannot withdraw the same prompt
		// twice.
		s.emitEvent(agent.RequestCancelledEvent{RequestID: requestID})
		select {
		case pending.(chan string) <- decisionCancel:
		default:
		}
		return true
	})
}

// handleRequestUserInput refuses Codex's own ask-the-user tool.
//
// It is the counterpart of Claude's AskUserQuestion, and it never reaches a
// Pockode user for the same reason: it blocks the turn on an answer that would
// have to come from a surface Pockode does not offer, while question_post gets
// the same question to the user without holding anything open.
//
// Claude's is disabled at launch and this is not, because codex-cli 0.153.0
// offers no switch for it: nothing in thread/start, and `disabled_tools` is a
// per-MCP-server setting rather than one for the CLI's built-ins. So the refusal
// is all there is, and it goes where the model is waiting.
//
// The reply has exactly one slot — a list of answer strings per question id
// (ToolRequestUserInputResponse in the CLI's own schema, asserted in
// schema_integration_test.go) — so the refusal is the answer to every question
// asked. There is no field for "declined", and an empty answers map would read
// as "asked, and nothing came back", which says nothing about what to do next.
func (s *appSession) handleRequestUserInput(msg rpcMessage) {
	var params struct {
		Questions []struct {
			ID string `json:"id"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		// An answer keyed by nothing is still better than no reply at all, which
		// is a turn waiting for the rest of the process's life.
		s.log.Warn("could not read codex requestUserInput, refusing it unkeyed", "error", err)
	}

	answers := make(map[string]interface{}, len(params.Questions))
	for _, q := range params.Questions {
		answers[q.ID] = map[string]interface{}{"answers": []string{agent.CLIQuestionRefusal}}
	}

	s.log.Info("refusing codex requestUserInput", "questions", len(answers))
	s.sendRPCResponse(*msg.ID, map[string]interface{}{"answers": answers}, nil)
	s.emitEvent(agent.CLIQuestionRefusedWarning("Codex"))
}
