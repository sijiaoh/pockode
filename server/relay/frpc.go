package relay

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

type FrpcRunner struct {
	binDir     string
	configPath string
	binPath    string // set by EnsureBinary
	cmd        *exec.Cmd
	log        *slog.Logger
}

func NewFrpcRunner(dataDir string, log *slog.Logger) *FrpcRunner {
	return &FrpcRunner{
		binDir:     filepath.Join(dataDir, "bin"),
		configPath: filepath.Join(dataDir, "frpc.toml"),
		log:        log,
	}
}

func (f *FrpcRunner) EnsureBinary(ctx context.Context, version string) error {
	f.binPath = f.versionedPath(version)

	if _, err := os.Stat(f.binPath); err == nil {
		f.log.Debug("frpc binary exists", "version", version)
		return nil
	}

	f.log.Info("downloading frpc", "version", version)

	if err := os.MkdirAll(f.binDir, 0755); err != nil {
		return fmt.Errorf("create bin dir: %w", err)
	}

	url := buildDownloadURL(version, runtime.GOOS, runtime.GOARCH)
	if err := f.downloadAndExtract(ctx, url); err != nil {
		return fmt.Errorf("download frpc: %w", err)
	}

	f.log.Info("frpc downloaded", "version", version)
	return nil
}

func (f *FrpcRunner) versionedPath(version string) string {
	return filepath.Join(f.binDir, "frpc-"+version)
}

func buildDownloadURL(version, goos, goarch string) string {
	return fmt.Sprintf(
		"https://github.com/fatedier/frp/releases/download/v%s/frp_%s_%s_%s.tar.gz",
		version, version, goos, goarch,
	)
}

func (f *FrpcRunner) downloadAndExtract(ctx context.Context, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed: %s", resp.Status)
	}

	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return fmt.Errorf("gzip reader: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar reader: %w", err)
		}

		// Only extract frpc binary
		if !strings.HasSuffix(header.Name, "/frpc") {
			continue
		}

		outFile, err := os.OpenFile(f.binPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
		if err != nil {
			return fmt.Errorf("create binary: %w", err)
		}

		if _, err := io.Copy(outFile, tr); err != nil {
			outFile.Close()
			return fmt.Errorf("extract binary: %w", err)
		}
		outFile.Close()

		return nil
	}

	return fmt.Errorf("frpc binary not found in archive")
}

func (f *FrpcRunner) GenerateConfig(cfg *StoredConfig, localPort int) error {
	customDomain := cfg.Subdomain + "." + cfg.FrpServer

	config := fmt.Sprintf(`serverAddr = "%s"
serverPort = %d
auth.token = "%s"

[[proxies]]
name = "http"
type = "http"
localPort = %d
customDomains = ["%s"]
`, cfg.FrpServer, cfg.FrpPort, cfg.FrpToken, localPort, customDomain)

	if err := os.MkdirAll(filepath.Dir(f.configPath), 0755); err != nil {
		return err
	}

	// Use 0600 to protect the token
	return os.WriteFile(f.configPath, []byte(config), 0600)
}

// Start blocks until frpc exits or context is cancelled.
func (f *FrpcRunner) Start(ctx context.Context) error {
	f.cmd = exec.CommandContext(ctx, f.binPath, "-c", f.configPath)
	f.cmd.Stdout = os.Stdout
	f.cmd.Stderr = os.Stderr

	if err := f.cmd.Start(); err != nil {
		return fmt.Errorf("start frpc: %w", err)
	}

	f.log.Info("frpc started", "pid", f.cmd.Process.Pid)

	err := f.cmd.Wait()
	if ctx.Err() != nil {
		// Context cancelled, normal shutdown
		return nil
	}
	if err != nil {
		return fmt.Errorf("frpc exited: %w", err)
	}

	return nil
}

func (f *FrpcRunner) Stop() {
	if f.cmd == nil || f.cmd.Process == nil {
		return
	}

	f.log.Info("stopping frpc", "pid", f.cmd.Process.Pid)

	// Send SIGTERM for graceful shutdown
	f.cmd.Process.Signal(syscall.SIGTERM)

	// Give it 5 seconds to exit gracefully
	done := make(chan struct{})
	go func() {
		f.cmd.Wait()
		close(done)
	}()

	select {
	case <-done:
		f.log.Info("frpc stopped gracefully")
	case <-time.After(5 * time.Second):
		f.log.Warn("frpc did not stop gracefully, killing")
		f.cmd.Process.Kill()
	}
}
