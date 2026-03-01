package agent

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/pockode/server/logger"
)

const StderrReadTimeout = 5 * time.Second

// ReadStderr collects all stderr output from a subprocess into a channel.
// The returned channel receives the full stderr content when the reader is exhausted.
func ReadStderr(stderr io.Reader, agentName string) <-chan string {
	ch := make(chan string, 1)
	go func() {
		var content strings.Builder
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, fmt.Sprintf("failed to read %s stderr", agentName))
			}
			ch <- content.String()
		}()
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			content.WriteString(scanner.Text())
			content.WriteString("\n")
		}
		if err := scanner.Err(); err != nil {
			slog.Error("stderr scanner error", "error", err)
		}
	}()
	return ch
}

// WaitForProcess waits for a subprocess to exit and emits an ErrorEvent if it
// terminated unexpectedly (i.e. not due to context cancellation).
func WaitForProcess(ctx context.Context, log *slog.Logger, cmd *exec.Cmd, stderrCh <-chan string, events chan<- AgentEvent) {
	var stderrContent string
	select {
	case stderrContent = <-stderrCh:
	case <-time.After(StderrReadTimeout):
	}

	if err := cmd.Wait(); err != nil {
		if ctx.Err() == nil {
			errMsg := stderrContent
			if errMsg == "" {
				errMsg = err.Error()
			}
			select {
			case events <- ErrorEvent{Error: errMsg}:
			case <-ctx.Done():
			}
		}
	}

	log.Info("process exited")
}
