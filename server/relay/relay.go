package relay

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
)

type Config struct {
	CloudURL  string
	DataDir   string
	LocalPort int
}

type Manager struct {
	config    Config
	store     *Store
	client    *Client
	frpc      *FrpcRunner
	log       *slog.Logger
	cancel    context.CancelFunc
	remoteURL string
	wg        sync.WaitGroup
}

func NewManager(cfg Config, log *slog.Logger) *Manager {
	return &Manager{
		config: cfg,
		store:  NewStore(cfg.DataDir),
		client: NewClient(cfg.CloudURL),
		frpc:   NewFrpcRunner(cfg.DataDir, log),
		log:    log.With("module", "relay"),
	}
}

// Start is non-blocking: runs frpc in background goroutine.
func (m *Manager) Start(ctx context.Context) (string, error) {
	storedCfg, err := m.store.Load()
	if err != nil {
		return "", fmt.Errorf("load config: %w", err)
	}

	if storedCfg == nil {
		m.log.Info("registering with cloud", "url", m.config.CloudURL)

		storedCfg, err = m.client.Register(ctx)
		if err != nil {
			return "", fmt.Errorf("register: %w", err)
		}

		if err := m.store.Save(storedCfg); err != nil {
			return "", fmt.Errorf("save config: %w", err)
		}

		m.log.Info("registered with cloud", "subdomain", storedCfg.Subdomain)
	} else {
		m.log.Info("using stored config", "subdomain", storedCfg.Subdomain)
	}

	if err := m.frpc.EnsureBinary(ctx, storedCfg.FrpVersion); err != nil {
		return "", fmt.Errorf("ensure frpc binary: %w", err)
	}

	if err := m.frpc.GenerateConfig(storedCfg, m.config.LocalPort); err != nil {
		return "", fmt.Errorf("generate frpc config: %w", err)
	}

	m.remoteURL = buildRemoteURL(storedCfg)

	frpcCtx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel

	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		if err := m.frpc.Start(frpcCtx); err != nil {
			m.log.Error("frpc exited with error", "error", err)
		}
	}()

	return m.remoteURL, nil
}

func (m *Manager) Stop() {
	if m.cancel != nil {
		m.cancel()
	}
	m.frpc.Stop()
	m.wg.Wait()
	m.log.Info("relay stopped")
}

func (m *Manager) RemoteURL() string {
	return m.remoteURL
}

func buildRemoteURL(cfg *StoredConfig) string {
	scheme := "https"
	if cfg.FrpServer == "local.pockode.com" {
		scheme = "http"
	}
	return fmt.Sprintf("%s://%s.%s", scheme, cfg.Subdomain, cfg.FrpServer)
}
