package relay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pockode/server/logger"
)

type Config struct {
	CloudURL      string
	DataDir       string
	ClientVersion string
}

// Establishing a tunnel has no keepalive to fall back on: the multiplexer only
// starts pinging once the handshake is done. http.DefaultTransport bounds the
// TCP dial and the TLS handshake, but nothing bounds the wait for the 101
// response, nor the wait for the register reply, so a peer that accepts the
// connection and then answers nothing blocks both forever — and one stalled
// attempt parks the reconnect loop for good. A blackholed network produces
// that; so would a cloud still holding the previous registration — a hypothesis
// only, since the cloud is not part of this repository. The bound does not
// depend on which it is; it only keeps the loop turning.
const connectTimeout = 15 * time.Second

type Manager struct {
	config         Config
	backendPort    int
	frontendPort   int
	store          *Store
	client         *Client
	log            *slog.Logger
	cancel         context.CancelFunc
	remoteURL      string
	wg             sync.WaitGroup
	newStreamCh    chan *VirtualStream
	connectTimeout time.Duration
}

func NewManager(cfg Config, backendPort, frontendPort int, log *slog.Logger) *Manager {
	return &Manager{
		config:         cfg,
		backendPort:    backendPort,
		frontendPort:   frontendPort,
		store:          NewStore(cfg.DataDir),
		client:         NewClientWithVersion(cfg.CloudURL, cfg.ClientVersion),
		log:            log.With("module", "relay"),
		newStreamCh:    make(chan *VirtualStream),
		connectTimeout: connectTimeout,
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
		if errors.Is(err, ErrUpgradeRequired) {
			return "", ErrUpgradeRequired
		}
		if err != nil {
			return "", fmt.Errorf("register: %w", err)
		}

		if err := m.store.Save(storedCfg); err != nil {
			return "", fmt.Errorf("save config: %w", err)
		}

		m.log.Info("registered with cloud", "subdomain", storedCfg.Subdomain)
	} else {
		m.log.Info("refreshing config from cloud", "subdomain", storedCfg.Subdomain)

		refreshedCfg, err := m.client.Refresh(ctx, storedCfg.RelayToken)
		if errors.Is(err, ErrUpgradeRequired) {
			return "", ErrUpgradeRequired
		}
		if errors.Is(err, ErrInvalidToken) {
			m.log.Warn("stored token is invalid, re-registering")
			if err := m.store.Delete(); err != nil {
				return "", fmt.Errorf("delete config: %w", err)
			}
			return m.Start(ctx)
		}
		if err != nil {
			return "", fmt.Errorf("refresh: %w", err)
		}

		if err := m.store.Save(refreshedCfg); err != nil {
			return "", fmt.Errorf("save config: %w", err)
		}

		storedCfg = refreshedCfg
		m.log.Info("config refreshed", "subdomain", storedCfg.Subdomain)
	}

	m.remoteURL = buildRemoteURL(storedCfg)

	relayCtx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel

	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, "relay connection crashed")
			}
		}()
		m.runWithReconnect(relayCtx, buildRelayWSURL(storedCfg), storedCfg.RelayToken)
	}()

	return m.remoteURL, nil
}

func (m *Manager) runWithReconnect(ctx context.Context, url, relayToken string) {
	backoff := time.Second
	attempt := 0

	for ctx.Err() == nil {
		start := time.Now()
		attempt++
		err := m.connectAndRun(ctx, url, relayToken, attempt)
		if ctx.Err() != nil {
			return
		}

		// A connection that stayed up for over a minute is jitter rather than an
		// unreachable network: retry at once and reset the backoff.
		stable := time.Since(start) > time.Minute
		retryIn := backoff
		if stable {
			retryIn = 0
		}
		m.log.Error("relay disconnected, reconnecting", "error", err, "retryIn", retryIn)

		if stable {
			backoff = time.Second
			continue
		}

		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func (m *Manager) connectAndRun(ctx context.Context, url, relayToken string, attempt int) error {
	m.log.Info("connecting to relay", "url", url, "attempt", attempt)

	// HTTPClient.Timeout is the library-supported way to bound the handshake;
	// it is cleared once the connection is established, so it never truncates
	// the tunnel itself.
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPClient: &http.Client{Timeout: m.connectTimeout},
	})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	conn.SetReadLimit(10 * 1024 * 1024) // 10MB for HTTP responses
	// CloseNow instead of a graceful close: this path is reached precisely when
	// the peer is unresponsive, and a close handshake nobody answers costs the
	// reconnect loop up to ~25s of the library's internal timeouts.
	defer conn.CloseNow()

	registerCtx, cancelRegister := context.WithTimeout(ctx, m.connectTimeout)
	err = m.register(registerCtx, conn, relayToken)
	cancelRegister()
	if err != nil {
		return fmt.Errorf("register: %w", err)
	}

	// attempt is what tells a reconnect apart from the first connect, and a
	// stuck loop apart from a quiet one.
	m.log.Info("relay connected", "attempt", attempt)

	httpHandler := NewHTTPHandler(m.backendPort, m.frontendPort, m.log)
	mux := NewMultiplexer(conn, m.newStreamCh, httpHandler, m.log)
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
