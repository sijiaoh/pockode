package ws

import (
	"context"
	"errors"

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
		h.replyFileError(ctx, conn, req, err, contents.ErrNotFound)
		return
	}

	var response rpc.FileGetResult
	switch {
	case result.Link != nil:
		response = rpc.FileGetResult{
			Type: "link",
			Link: result.Link,
		}
	case result.IsDir():
		response = rpc.FileGetResult{
			Type:    "directory",
			Entries: result.Entries,
		}
	default:
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
		h.replyFileError(ctx, conn, req, err, contents.ErrTooLarge)
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
		h.replyFileError(ctx, conn, req, err, contents.ErrExists)
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

	if err := contents.Delete(wt.WorkDir, params.Path); err != nil {
		h.replyFileError(ctx, conn, req, err, contents.ErrNotFound)
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
		h.replyFileError(ctx, conn, req, err, contents.ErrNotFound, contents.ErrExists)
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
			refuse(rpc.FileMoveReasonInvalidPath, contents.PublicMessage(err))
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
			h.log.Error("file.move failed", "path", params.Path, "error", err)
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, contents.PublicMessage(err))
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

	result, err := search.Search(ctx, wt.WorkDir, search.Options{
		Query:            params.Query,
		Mode:             search.Mode(params.Mode),
		Path:             params.Path,
		RespectGitignore: respectGitignore,
		MaxResults:       params.MaxResults,
	})
	if err != nil {
		switch {
		case errors.Is(err, search.ErrEmptyQuery), errors.Is(err, search.ErrQueryTooLong),
			errors.Is(err, search.ErrInvalidMode):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		default:
			// The scope is resolved like any file route's path, so it fails
			// the same ways and is answered the same way.
			h.replyFileError(ctx, conn, req, err, contents.ErrNotFound, contents.ErrNotADirectory)
		}
		return
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send file search response", "error", err)
	}
}

// replyFileError answers a failed file route. ErrInvalidPath and the route's
// expected refusals are the client's mistake; anything else is a fault here,
// logged in full while the client gets only what contents.PublicMessage lets
// through — an OS error names host paths (docs/symlinks.md#the-boundary).
func (h *rpcMethodHandler) replyFileError(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, err error, refusals ...error) {
	message := contents.PublicMessage(err)
	if errors.Is(err, contents.ErrInvalidPath) {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, message)
		return
	}
	for _, refusal := range refusals {
		if errors.Is(err, refusal) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, message)
			return
		}
	}
	h.log.Error("file operation failed", "method", req.Method, "error", err)
	h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, message)
}
