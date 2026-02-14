package mcp

import (
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
)

type ErrorCode string

const (
	ErrNotFound   ErrorCode = "not_found"
	ErrValidation ErrorCode = "validation"
	ErrInternal   ErrorCode = "internal"
)

type ToolError struct {
	Code    ErrorCode      `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func (e ToolError) ToResult() *mcp.CallToolResult {
	data, _ := json.Marshal(e)
	return mcp.NewToolResultError(string(data))
}

func NotFound(resource, id string) *mcp.CallToolResult {
	return ToolError{
		Code:    ErrNotFound,
		Message: resource + " not found",
		Details: map[string]any{resource + "_id": id},
	}.ToResult()
}

func ValidationError(msg string) *mcp.CallToolResult {
	return ToolError{
		Code:    ErrValidation,
		Message: msg,
	}.ToResult()
}

func InternalError(err error) *mcp.CallToolResult {
	return ToolError{
		Code:    ErrInternal,
		Message: err.Error(),
	}.ToResult()
}
