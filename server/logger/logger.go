package logger

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

type Config struct {
	DataDir string
	DevMode bool
}

// Init initializes the global slog logger.
// In production (DevMode=false), logs are written to dataDir/server.log.
// In development (DevMode=true), logs are written to stdout.
// LOG_FILE env overrides the default file path.
func Init(cfg Config) {
	level := parseLevel(os.Getenv("LOG_LEVEL"))
	opts := &slog.HandlerOptions{Level: level}

	var w io.Writer = os.Stdout

	logFile := os.Getenv("LOG_FILE")
	if logFile == "" && !cfg.DevMode && cfg.DataDir != "" {
		logFile = filepath.Join(cfg.DataDir, "server.log")
	}

	if logFile != "" {
		if err := os.MkdirAll(filepath.Dir(logFile), 0755); err != nil {
			slog.Error("failed to create log directory, using stdout only", "file", logFile, "error", err)
		} else {
			f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
			if err != nil {
				slog.Error("failed to open log file, using stdout only", "file", logFile, "error", err)
			} else {
				w = f
			}
		}
	}

	var handler slog.Handler
	if os.Getenv("LOG_FORMAT") == "json" {
		handler = slog.NewJSONHandler(w, opts)
	} else {
		handler = slog.NewTextHandler(w, opts)
	}

	slog.SetDefault(slog.New(handler))
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// NewRequestLogger creates a logger with a unique requestId for API handlers.
func NewRequestLogger() *slog.Logger {
	return slog.With("requestId", uuid.Must(uuid.NewV7()).String())
}
