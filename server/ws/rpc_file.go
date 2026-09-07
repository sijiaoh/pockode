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
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send file write response", "error", err)
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
		CaseSensitive:    params.CaseSensitive,
		MaxResults:       params.MaxResults,
	})
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
