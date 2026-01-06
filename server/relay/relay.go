package relay

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type Config struct {
	CloudURL string
	DataDir  string
}

type Manager struct {
	config      Config
	store       *Store
	client      *Client
	log         *slog.Logger
	cancel      context.CancelFunc
	remoteURL   string
	wg          sync.WaitGroup
	newStreamCh chan *VirtualStream
}

func NewManager(cfg Config, log *slog.Logger) *Manager {
	return &Manager{
		config:      cfg,
		store:       NewStore(cfg.DataDir),
		client:      NewClient(cfg.CloudURL),
		log:         log.With("module", "relay"),
		newStreamCh: make(chan *VirtualStream),
	}
}

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

	m.remoteURL = buildRemoteURL(storedCfg)

	relayCtx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel

	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.runWithReconnect(relayCtx, storedCfg)
	}()

	return m.remoteURL, nil
}

func (m *Manager) runWithReconnect(ctx context.Context, cfg *StoredConfig) {
	backoff := time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		start := time.Now()
		err := m.connectAndRun(ctx, cfg)
		if ctx.Err() != nil {
			return
		}

		// Reset backoff if connection was stable (> 1 minute)
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}

		m.log.Error("relay connection failed", "error", err, "backoff", backoff)
		time.Sleep(backoff)

		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (m *Manager) connectAndRun(ctx context.Context, cfg *StoredConfig) error {
	url := buildRelayWSURL(cfg)
	m.log.Info("connecting to relay", "url", url)

	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	if err := m.register(ctx, conn, cfg.RelayToken); err != nil {
		return fmt.Errorf("register: %w", err)
	}

	m.log.Info("connected to relay")

	mux := NewMultiplexer(conn, m.newStreamCh, m.log)
	return mux.Run(ctx)
}

type registerRequest struct {
	JSONRPC string            `json:"jsonrpc"`
	Method  string            `json:"method"`
	Params  map[string]string `json:"params"`
	ID      int               `json:"id"`
}

type registerResponse struct {
	Result *struct {
		Status string `json:"status"`
	} `json:"result"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (m *Manager) register(ctx context.Context, conn *websocket.Conn, relayToken string) error {
	req := registerRequest{
		JSONRPC: "2.0",
		Method:  "register",
		Params:  map[string]string{"relay_token": relayToken},
		ID:      1,
	}

	if err := wsjson.Write(ctx, conn, req); err != nil {
		return fmt.Errorf("write register: %w", err)
	}

	var resp registerResponse
	if err := wsjson.Read(ctx, conn, &resp); err != nil {
		return fmt.Errorf("read register response: %w", err)
	}

	if resp.Error != nil {
		return fmt.Errorf("register failed: %s", resp.Error.Message)
	}

	return nil
}

func (m *Manager) Stop() {
	if m.cancel != nil {
		m.cancel()
	}
	m.wg.Wait()
	close(m.newStreamCh)
	m.log.Info("relay stopped")
}

func (m *Manager) RemoteURL() string {
	return m.remoteURL
}

func (m *Manager) NewStreams() <-chan *VirtualStream {
	return m.newStreamCh
}

func buildRemoteURL(cfg *StoredConfig) string {
	scheme := "https"
	if cfg.RelayServer == "local.pockode.com" {
		scheme = "http"
	}
	return fmt.Sprintf("%s://%s.%s", scheme, cfg.Subdomain, cfg.RelayServer)
}

func buildRelayWSURL(cfg *StoredConfig) string {
	scheme := "wss"
	if cfg.RelayServer == "local.pockode.com" {
		scheme = "ws"
	}
	return fmt.Sprintf("%s://%s.%s/relay", scheme, cfg.Subdomain, cfg.RelayServer)
}
