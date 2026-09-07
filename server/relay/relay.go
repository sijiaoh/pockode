package relay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

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

// connectTimeout bounds the uplink handshake. Nothing else does: yamux only
// starts its keepalive once the tunnel is up, and while http.DefaultTransport
// bounds the TCP dial and the TLS handshake, nothing bounds the wait for the
// 101 response. A peer that accepts the connection and then answers nothing
// would park the reconnect loop for good — which is what a blackholed network
// looks like from here.
const connectTimeout = 15 * time.Second

type Config struct {
	CloudURL      string
	DataDir       string
	ClientVersion string
}

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
		r := &reconnector{connect: m.connectAndRun, clock: realClock{}, log: m.log}
		r.run(relayCtx, storedCfg)
	}()

	return m.remoteURL, nil
}

func (m *Manager) connectAndRun(ctx context.Context, cfg *StoredConfig) error {
	url := buildRelayWSURL(cfg)
	m.log.Info("connecting to relay", "url", url)

	conn, resp, err := websocket.Dial(ctx, url, m.uplinkDialOptions(cfg.RelayToken))
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("relay rejected relay_token: %w", err)
		}
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.CloseNow()

	m.log.Info("connected to relay")

	// NetConn disables the WebSocket read limit, which is what a byte-stream
	// tunnel wants: size limits belong to the HTTP layer above it.
	tunnel := tunnelConn{Conn: websocket.NetConn(ctx, conn, websocket.MessageBinary), ws: conn}
	return serveTunnel(ctx, tunnel, newLocalProxy(m.backendPort, m.frontendPort, m.log), m.log)
}

// uplinkDialOptions puts the relay token on the upgrade request itself, so the
// cloud can reject an unauthorized server with a plain 401. Past the 101 the
// connection carries nothing but the yamux session.
func (m *Manager) uplinkDialOptions(relayToken string) *websocket.DialOptions {
	return &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + relayToken}},
		// HTTPClient.Timeout is the library-supported way to bound the
		// handshake: coder/websocket turns it into a context it cancels the
		// moment Dial returns, so it bounds the wait for the 101 without ever
		// truncating the tunnel that follows. That second half is not obvious
		// and getting it wrong would drop every tunnel on a timer, so
		// TestUplinkDialOptionsDoNotTruncateTheTunnel pins it.
		HTTPClient:      &http.Client{Timeout: m.connectTimeout},
		CompressionMode: tunnelCompression,
	}
}

// tunnelConn is the byte stream yamux runs on. Its Close hangs up rather than
// running a WebSocket close handshake: yamux closes the connection when the
// session ends, which is precisely when the peer has stopped answering, and a
// handshake nobody completes costs the reconnect loop up to 25 s of the
// library's internal timeouts.
type tunnelConn struct {
	net.Conn
	ws *websocket.Conn
}

func (c tunnelConn) Close() error {
	err := c.ws.CloseNow()
	// The wrapped net.Conn still owns the deadline timers and contexts it set
	// up; it finds the WebSocket already closed and returns at once.
	c.Conn.Close()
	return err
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
