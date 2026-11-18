package ws

import (
	"context"
	"errors"
	"sync"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/search"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleFileGet(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.FileGetParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	result, err := contents.GetContents(wt.WorkDir, params.Path)
	if err != nil {
		if errors.Is(err, contents.ErrNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		if errors.Is(err, contents.ErrInvalidPath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	var response rpc.FileGetResult
	if result.IsDir() {
		response = rpc.FileGetResult{
			Type:    "directory",
			Entries: result.Entries,
		}
	} else {
		response = rpc.FileGetResult{
			Type: "file",
			File: result.File,
		}
	}

	if err := conn.Reply(ctx, req.ID, response); err != nil {
		h.log.Error("failed to send file get response", "error", err)
	}
}

func (h *rpcMethodHandler) handleFileWrite(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.FileWriteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := contents.WriteFile(wt.WorkDir, params.Path, params.Content); err != nil {
		if errors.Is(err, contents.ErrInvalidPath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path")
			return
		}
		if errors.Is(err, contents.ErrTooLarge) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send file write response", "error", err)
	}
}

func (h *rpcMethodHandler) handleFileCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.FileCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	var isDir bool
	switch params.Type {
	case contents.TypeFile:
	case contents.TypeDir:
		isDir = true
	default:
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, `type must be "file" or "dir"`)
		return
	}

	if err := contents.Create(wt.WorkDir, params.Path, isDir); err != nil {
		switch {
		case errors.Is(err, contents.ErrInvalidPath):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path")
		case errors.Is(err, contents.ErrExists):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		default:
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		}
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send file create response", "error", err)
	}
}

func (h *rpcMethodHandler) handleFileDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.FileDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := contents.DeleteFile(wt.WorkDir, params.Path); err != nil {
		if errors.Is(err, contents.ErrInvalidPath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path")
			return
		}
		if errors.Is(err, contents.ErrNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send file delete response", "error", err)
	}
}

func (h *rpcMethodHandler) handleFileRename(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.FileRenameParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := contents.Rename(wt.WorkDir, params.Path, params.NewName); err != nil {
		switch {
		case errors.Is(err, contents.ErrInvalidPath):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path")
		case errors.Is(err, contents.ErrNotFound), errors.Is(err, contents.ErrExists):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		default:
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		}
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send file rename response", "error", err)
	}
}

func (h *rpcMethodHandler) handleFileMove(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.FileMoveParams
	if err := unmarshalParams(req, &params); err != nil || params.Destination == nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	newPath, err := contents.Move(wt.WorkDir, params.Path, *params.Destination)
	if err != nil {
		refuse := func(reason, message string) {
			h.replyErrorData(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, message, rpc.FileMoveErrorData{Reason: reason})
		}
		switch {
		case errors.Is(err, contents.ErrInvalidPath):
			refuse(rpc.FileMoveReasonInvalidPath, "invalid path")
		case errors.Is(err, contents.ErrNotFound):
			refuse(rpc.FileMoveReasonNotFound, err.Error())
		case errors.Is(err, contents.ErrDestinationNotFound):
			refuse(rpc.FileMoveReasonDestinationNotFound, err.Error())
		case errors.Is(err, contents.ErrNotADirectory):
			refuse(rpc.FileMoveReasonNotADirectory, err.Error())
		case errors.Is(err, contents.ErrIntoItself):
			refuse(rpc.FileMoveReasonIntoItself, err.Error())
		case errors.Is(err, contents.ErrExists):
			refuse(rpc.FileMoveReasonExists, err.Error())
		default:
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		}
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.FileMoveResult{Path: newPath}); err != nil {
		h.log.Error("failed to send file move response", "error", err)
	}
}

func (h *rpcMethodHandler) handleFileSearch(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.FileSearchParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	respectGitignore := true
	if params.RespectGitignore != nil {
		respectGitignore = *params.RespectGitignore
	}

	searchCtx, finish := h.state.searches.start(ctx, wt.Name, requestArrival(ctx))
	defer finish()

	result, err := h.searchFiles(searchCtx, wt.WorkDir, search.Options{
		Query:            params.Query,
		Mode:             search.Mode(params.Mode),
		Path:             params.Path,
		RespectGitignore: respectGitignore,
		MaxResults:       params.MaxResults,
	})
	// Checked before err: a superseded search ends however its cancellation
	// happened to stop it — usually as a truncated result, which must not
	// reach the client looking like an answer.
	if errors.Is(context.Cause(searchCtx), errFileSearchSuperseded) {
		h.replyError(ctx, conn, req.ID, rpc.CodeFileSearchSuperseded, errFileSearchSuperseded.Error())
		return
	}
	if err != nil {
		switch {
		case errors.Is(err, search.ErrEmptyQuery), errors.Is(err, search.ErrQueryTooLong),
			errors.Is(err, search.ErrInvalidMode), errors.Is(err, contents.ErrNotFound):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		case errors.Is(err, contents.ErrInvalidPath):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path")
		default:
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		}
		return
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send file search response", "error", err)
	}
}

var errFileSearchSuperseded = errors.New("superseded by a newer file search")

// fileSearches makes the newest file.search on a connection win, per
// worktree: the one search UI sends a request per settled keystroke, each a
// scan of the whole repository, and only the last one's answer is wanted. Left
// to run, a few seconds of typing stack up several scans that compete with the
// agent for CPU and disk until each reaches its timeout.
type fileSearches struct {
	searchesMu sync.Mutex
	newest     map[string]fileSearch // by worktree name
}

type fileSearch struct {
	arrival uint64
	cancel  context.CancelCauseFunc // nil once the search has finished
}

// start registers a search and returns its context, which ends with
// errFileSearchSuperseded as its cause when a search that arrived later
// starts. arrival orders searches rather than the order start is called in:
// handlers run concurrently, so the older of two can get here second, and is
// then superseded before it begins. finish must be called when the search
// ends.
func (s *fileSearches) start(parent context.Context, worktree string, arrival uint64) (context.Context, func()) {
	ctx, cancel := context.WithCancelCause(parent)

	s.searchesMu.Lock()
	defer s.searchesMu.Unlock()
	newest, ok := s.newest[worktree]
	if ok && newest.arrival > arrival {
		cancel(errFileSearchSuperseded)
		return ctx, func() {}
	}
	if ok && newest.cancel != nil {
		newest.cancel(errFileSearchSuperseded)
	}
	if s.newest == nil {
		s.newest = make(map[string]fileSearch)
	}
	// The entry outlives the search, keeping its arrival, so that an older
	// search reaching start only after this one has finished still loses.
	s.newest[worktree] = fileSearch{arrival: arrival, cancel: cancel}

	return ctx, func() {
		s.searchesMu.Lock()
		if s.newest[worktree].arrival == arrival {
			s.newest[worktree] = fileSearch{arrival: arrival}
		}
		s.searchesMu.Unlock()
		cancel(nil)
	}
}
