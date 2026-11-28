package ws

import (
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// The record describes the files as the server read them from the stored
// bytes, not as the client said they were.
func TestHandler_MessageWithAttachments(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnvWithAgent(t, mock, attachmentMockAgent{mock}, t.TempDir())
	row, _ := env.createSession()
	id, err := attachments.NewStore(env.getMainWorktree().DataDir, row.ID).Put(pngPixel, ".png")
	if err != nil {
		t.Fatal(err)
	}

	resp := env.call("chat.message", rpc.MessageParams{
		SessionID:   row.ID,
		Attachments: []rpc.MessageAttachmentParams{{ID: id, Name: "shot.png"}},
	})
	if resp.Error != nil {
		t.Fatalf("chat.message failed: %s", resp.Error.Message)
	}
	if got := mock.sentMessagesFor(row.ID); len(got) != 1 {
		t.Errorf("agent was sent %q, want the message once", got)
	}
	records := messageRecords(t, env, row.ID)
	if len(records) != 1 || len(records[0].Attachments) != 1 {
		t.Fatalf("message records = %+v, want one carrying the file", records)
	}
	got := records[0].Attachments[0]
	if got.AttachmentID != id || got.Name != "shot.png" || got.MIME != "image/png" || got.Width != 1 || got.Height != 1 {
		t.Errorf("described as %+v", got)
	}
}

func TestHandler_MessageWithAttachmentsRefused(t *testing.T) {
	tests := []struct {
		name string
		// receives is whether the agent's sessions take files at all.
		receives bool
		params   func(sessionID, id string) rpc.MessageParams
	}{
		{"an id the session does not have", true, func(sessionID, _ string) rpc.MessageParams {
			return rpc.MessageParams{SessionID: sessionID, Content: "look",
				Attachments: []rpc.MessageAttachmentParams{{ID: "../../index.json"}}}
		}},
		{"a session the worktree does not have", true, func(_, id string) rpc.MessageParams {
			return rpc.MessageParams{SessionID: "../../elsewhere", Content: "look",
				Attachments: []rpc.MessageAttachmentParams{{ID: id}}}
		}},
		{"files beside answers", true, func(sessionID, id string) rpc.MessageParams {
			return rpc.MessageParams{SessionID: sessionID,
				Answering:   []rpc.QuestionAnswerParams{{RequestID: "r", Declined: true}},
				Attachments: []rpc.MessageAttachmentParams{{ID: id}}}
		}},
		{"an agent that cannot receive files", false, func(sessionID, id string) rpc.MessageParams {
			return rpc.MessageParams{SessionID: sessionID, Content: "look",
				Attachments: []rpc.MessageAttachmentParams{{ID: id}}}
		}},
		{"nothing at all", true, func(sessionID, _ string) rpc.MessageParams {
			return rpc.MessageParams{SessionID: sessionID}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockAgent{}
			var ag agent.Agent = mock
			if tt.receives {
				ag = attachmentMockAgent{mock}
			}
			env := newTestEnvWithAgent(t, mock, ag, t.TempDir())
			row, _ := env.createSession()
			id, err := attachments.NewStore(env.getMainWorktree().DataDir, row.ID).Put(pngPixel, ".png")
			if err != nil {
				t.Fatal(err)
			}

			resp := env.call("chat.message", tt.params(row.ID, id))
			if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
				t.Fatalf("response = %+v, want CodeInvalidParams", resp)
			}
			if got := mock.sentMessagesFor(row.ID); len(got) != 0 {
				t.Errorf("agent was sent %q, want nothing", got)
			}
		})
	}
}
