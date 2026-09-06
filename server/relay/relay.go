package relay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/pockode/server/logger"
)

// tunnelCompression negotiates permessage-deflate on the relay uplink. It must
// match the cloud's AcceptOptions (server/relay/ws.go in pockode-cloud), which
// is where the reasoning for context takeover lives: the weaker of the two
// offers wins, and it wins for both directions.
//
// Context takeover retains a flate.Writer for the life of the connection —
// one per pockode process here, but one per connected server on the cloud,
// which is where that cost actually lands.
const tunnelCompression = websocket.CompressionContextTakeover

type Config struct {
	CloudURL      string
	DataDir       string
	ClientVersion string
}

type Manager struct {
	config       Config
	backendPort  int
	frontendPort int
	store        *Store
	client       *Client
	log          *slog.Logger
	cancel       context.CancelFunc
	remoteURL    string
	wg           sync.WaitGroup
}

func NewManager(cfg Config, backendPort, frontendPort int, log *slog.Logger) *Manager {
	return &Manager{
		config:       cfg,
		backendPort:  backendPort,
		frontendPort: frontendPort,
		store:        NewStore(cfg.DataDir),
		client:       NewClientWithVersion(cfg.CloudURL, cfg.ClientVersion),
		log:          log.With("module", "relay"),
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
		r := &reconnector{connect: m.connectAndRun, clock: realClock{}, log: m.log}
		r.run(relayCtx, storedCfg)
	}()

	return m.remoteURL, nil
}

func (m *Manager) connectAndRun(ctx context.Context, cfg *StoredConfig) error {
	url := buildRelayWSURL(cfg)
	m.log.Info("connecting to relay", "url", url)

	conn, resp, err := websocket.Dial(ctx, url, uplinkDialOptions(cfg.RelayToken))
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("relay rejected relay_token: %w", err)
		}
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	m.log.Info("connected to relay")

	// NetConn disables the WebSocket read limit, which is what a byte-stream
	// tunnel wants: size limits belong to the HTTP layer above it.
	return serveTunnel(ctx, websocket.NetConn(ctx, conn, websocket.MessageBinary),
		newLocalProxy(m.backendPort, m.frontendPort, m.log), m.log)
}

// uplinkDialOptions puts the relay token on the upgrade request itself, so the
// cloud can reject an unauthorized server with a plain 401. Past the 101 the
// connection carries nothing but the yamux session.
func uplinkDialOptions(relayToken string) *websocket.DialOptions {
	return &websocket.DialOptions{
		HTTPHeader:      http.Header{"Authorization": {"Bearer " + relayToken}},
		CompressionMode: tunnelCompression,
	}
}

func (m *Manager) Stop() {
	if m.cancel != nil {
		m.cancel()
	}
	m.wg.Wait()
	m.log.Info("relay stopped")
}

func (m *Manager) RemoteURL() string {
	return m.remoteURL
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
