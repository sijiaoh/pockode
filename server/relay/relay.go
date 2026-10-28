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
	"github.com/pockode/server/authguard"
	"github.com/pockode/server/cloudcred"
	"github.com/pockode/server/logger"
)

// tunnelCompression negotiates permessage-deflate on the relay uplink. It must
// match the cloud relay's AcceptOptions: the weaker of the two offers wins,
// and it wins for both directions.
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

// credentialPollInterval is how soon a running process notices `pockode login`
// or `pockode logout`: the cloud's account design promises 5 s.
const credentialPollInterval = 5 * time.Second

type Config struct {
	CloudURL      string
	DataDir       string
	ClientVersion string
	// Password and Sessions are the app's own credentials. Port previews log
	// in with them, since a previewed server knows nothing of Pockode's.
	Password string
	// PasswordGuard is the process's shared lockout, so a preview login
	// draws on the same allowance of wrong passwords as the app's own.
	PasswordGuard *authguard.Guard
	Sessions      SessionStore
	// Tickets are the one-time logins the app hands a preview tab, so it
	// gets a session without the password being typed again.
	Tickets TicketRedeemer
	// CloudCredentials is where the machine's link to a cloud account is read
	// from; nil leaves the relay a guest. Only a token issued by CloudURL is
	// used.
	CloudCredentials *cloudcred.Store
	// Instance is how this process is listed in the account it is attached to.
	Instance Instance
	// OnRemoteURLChange, if set, is called whenever renewing the credentials
	// moves the server to a different remote URL; RemoteURL already reports
	// the new one by then. An empty URL means remote access has ended for
	// good, because the cloud requires a newer Pockode to register again. It
	// runs on the reconnect loop, which waits for it before dialing again.
	OnRemoteURLChange func(remoteURL string)
}

// SessionStore is what a preview login needs of the app's session store;
// authsession.Store implements it.
type SessionStore interface {
	Issue() (string, error)
	Validate(token string) bool
}

// TicketRedeemer is what a preview login needs of the app's one-time login
// tickets; authsession.Tickets implements it.
type TicketRedeemer interface {
	Redeem(ticket string) bool
}

type Manager struct {
	config       Config
	backendPort  int
	frontendPort int
	store        *Store
	client       *Client
	log          *slog.Logger
	cancel       context.CancelFunc
	remoteURLMu  sync.Mutex // renewing the credentials can replace remoteURL
	remoteURL    string
	wg           sync.WaitGroup

	// cloudCallsMu serializes the calls that rewrite relay.json, since both
	// the reconnect loop and the credential watcher make them.
	cloudCallsMu sync.Mutex
	// presentedToken is the machine token ("" for none) the account state was
	// last settled for — whether the cloud attached it, rejected it, or the
	// request fell back to a guest's. The watcher refreshes when cloud.json no
	// longer agrees with it.
	presentedToken string
	// machineTokenErr is the last failure to read cloud.json, so the watcher
	// reports a persisting one once rather than every poll.
	machineTokenErr string
	// syncFailing is set while the watcher's refreshes keep failing, until the
	// account state is next settled, so an outage is reported once rather
	// than every poll.
	syncFailing bool

	accountMu sync.Mutex
	account   Account

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
	storedCfg, err := m.credentials(ctx)
	if err != nil {
		return "", err
	}

	remoteURL := buildRemoteURL(storedCfg)
	m.setRemoteURL(remoteURL)

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
		r := &reconnector{connect: m.connectAndRun, renew: m.renewCredentials, clock: realClock{}, log: m.log}
		r.run(relayCtx, storedCfg)
	}()

	if m.config.CloudCredentials != nil {
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			defer func() {
				if r := recover(); r != nil {
					logger.LogPanic(r, "cloud credential watcher crashed")
				}
			}()
			m.watchCloudCredentials(relayCtx)
		}()
	}

	return remoteURL, nil
}

// credentials returns the relay credentials to connect with: the stored ones
// once the cloud has confirmed them, or fresh ones from a new registration when
// there are none or the cloud no longer recognizes them.
func (m *Manager) credentials(ctx context.Context) (*StoredConfig, error) {
	m.cloudCallsMu.Lock()
	defer m.cloudCallsMu.Unlock()

	storedCfg, err := m.store.Load()
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}

	machineToken := m.machineToken()

	if storedCfg != nil {
		m.log.Info("refreshing config from cloud", "subdomain", storedCfg.Subdomain)

		refreshed, err := m.call(machineToken, func(attach *Attachment) (*Registration, error) {
			return m.client.Refresh(ctx, storedCfg.RelayToken, attach)
		})
		switch {
		case err == nil:
			if err := m.store.Save(&refreshed.StoredConfig); err != nil {
				return nil, fmt.Errorf("save config: %w", err)
			}
			m.log.Info("config refreshed", "subdomain", refreshed.Subdomain)
			return &refreshed.StoredConfig, nil
		case errors.Is(err, ErrUpgradeRequired):
			return nil, ErrUpgradeRequired
		case errors.Is(err, ErrInvalidToken):
			m.log.Warn("stored token is invalid, re-registering")
			if err := m.store.Delete(); err != nil {
				return nil, fmt.Errorf("delete config: %w", err)
			}
		default:
			return nil, fmt.Errorf("refresh: %w", err)
		}
	}

	m.log.Info("registering with cloud", "url", m.config.CloudURL)

	registered, err := m.call(machineToken, func(attach *Attachment) (*Registration, error) {
		return m.client.Register(ctx, attach)
	})
	if errors.Is(err, ErrUpgradeRequired) {
		return nil, ErrUpgradeRequired
	}
	if err != nil {
		return nil, fmt.Errorf("register: %w", err)
	}

	if err := m.store.Save(&registered.StoredConfig); err != nil {
		return nil, fmt.Errorf("save config: %w", err)
	}

	m.log.Info("registered with cloud", "subdomain", registered.Subdomain)
	return &registered.StoredConfig, nil
}

// call makes a register or refresh, attaching the relay to the machine's
// account when machineToken is set, and records what became of that.
//
// A refused attachment is retried as a guest, because the link to an account
// must never be what keeps the relay from working. The cloud does refuse some:
// it bounds the instance fields (a path with a control character is refused),
// and a cloud that predates accounts caps the whole body at 4 KiB, which a long
// path can exceed.
//
// The caller holds cloudCallsMu.
func (m *Manager) call(machineToken string, do func(*Attachment) (*Registration, error)) (*Registration, error) {
	var attach *Attachment
	if machineToken != "" {
		attach = &Attachment{MachineToken: machineToken, Instance: m.config.Instance}
	}

	reg, err := do(attach)
	if attach != nil && errors.Is(err, errRequestRefused) {
		m.log.Warn("cloud refused to attach this instance to the account, continuing as a guest", "instance", m.config.Instance, "error", err)
		reg, err = do(nil)
	}
	if err != nil {
		return nil, err
	}

	m.presentedToken = machineToken
	m.syncFailing = false
	m.setAccount(reg.Account)
	switch {
	case reg.Email != "":
		m.log.Info("attached to cloud account")
	case reg.Error != "":
		m.log.Warn("cloud did not accept the machine token, run `pockode login` to link this machine again", "account_error", reg.Error)
	}
	return reg, nil
}

// machineToken reads cloud.json afresh. A file it cannot read leaves the relay
// a guest rather than stopping it.
func (m *Manager) machineToken() string {
	if m.config.CloudCredentials == nil {
		return ""
	}
	token, err := m.config.CloudCredentials.MachineToken(m.config.CloudURL)
	if err != nil {
		if err.Error() != m.machineTokenErr {
			m.log.Warn("cannot read the cloud credential, continuing as a guest", "error", err)
		}
		m.machineTokenErr = err.Error()
		return ""
	}
	m.machineTokenErr = ""
	return token
}

// watchCloudCredentials refreshes whenever cloud.json changes, so a running
// process attaches on `pockode login` and detaches on `pockode logout` without
// a restart. A refresh keeps the subdomain, so the remote URL stays put.
func (m *Manager) watchCloudCredentials(ctx context.Context) {
	ticker := time.NewTicker(credentialPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if errors.Is(m.syncCloudCredentials(ctx), ErrUpgradeRequired) {
				return
			}
		}
	}
}

// syncCloudCredentials leaves a failed refresh to the next poll, which still
// sees cloud.json disagree with what was presented — except one whose relay
// token was rejected. Asking again cannot help that; the reconnect loop
// registers anew once its uplink is rejected too, and takes cloud.json along.
func (m *Manager) syncCloudCredentials(ctx context.Context) error {
	m.cloudCallsMu.Lock()
	defer m.cloudCallsMu.Unlock()

	machineToken := m.machineToken()
	if machineToken == m.presentedToken {
		return nil
	}

	// No stored credentials means the reconnect loop is registering, and it
	// reads cloud.json for itself.
	storedCfg, err := m.store.Load()
	if err != nil || storedCfg == nil {
		return err
	}

	if !m.syncFailing {
		m.log.Info("cloud credential changed, refreshing", "subdomain", storedCfg.Subdomain)
	}
	refreshed, err := m.call(machineToken, func(attach *Attachment) (*Registration, error) {
		return m.client.Refresh(ctx, storedCfg.RelayToken, attach)
	})
	if errors.Is(err, ErrInvalidToken) {
		m.log.Warn("cloud no longer recognizes the relay token, leaving the account change to the next registration")
		m.presentedToken = machineToken
		m.syncFailing = false
		return nil
	}
	if err != nil {
		if ctx.Err() == nil && !m.syncFailing {
			m.log.Warn("failed to refresh after the cloud credential changed, retrying every poll", "error", err)
		}
		m.syncFailing = true
		return err
	}
	return m.store.Save(&refreshed.StoredConfig)
}

// Account reports the relay's cloud account as of the last register or
// refresh; the zero value for a guest.
func (m *Manager) Account() Account {
	m.accountMu.Lock()
	defer m.accountMu.Unlock()
	return m.account
}

func (m *Manager) setAccount(account Account) {
	m.accountMu.Lock()
	defer m.accountMu.Unlock()
	m.account = account
}

// renewCredentials is how the reconnect loop recovers from an uplink rejected
// for its token: the same check startup makes, so a token the cloud has lost
// track of mid-run is replaced instead of being retried forever.
//
// A new registration comes with a new subdomain, and the old URL stops
// working, so the change is passed on to whoever exposes the remote URL. So is
// a cloud demanding a newer client: the loop gives up on that, and the URL of
// the rejected token is dead.
func (m *Manager) renewCredentials(ctx context.Context) (*StoredConfig, error) {
	cfg, err := m.credentials(ctx)
	if errors.Is(err, ErrUpgradeRequired) {
		m.changeRemoteURL("")
	}
	if err != nil {
		return nil, err
	}
	if remoteURL := buildRemoteURL(cfg); remoteURL != m.RemoteURL() {
		m.log.Warn("remote URL changed", "url", remoteURL)
		m.changeRemoteURL(remoteURL)
	}
	return cfg, nil
}

func (m *Manager) changeRemoteURL(url string) {
	m.setRemoteURL(url)
	if m.config.OnRemoteURLChange != nil {
		m.config.OnRemoteURLChange(url)
	}
}

func (m *Manager) connectAndRun(ctx context.Context, cfg *StoredConfig) error {
	url := buildRelayWSURL(cfg)
	m.log.Info("connecting to relay", "url", url)

	conn, err := m.dialUplink(ctx, url, cfg.RelayToken)
	if err != nil {
		return err
	}
	defer conn.CloseNow()

	m.log.Info("connected to relay")

	// NetConn disables the WebSocket read limit, which is what a byte-stream
	// tunnel wants: size limits belong to the HTTP layer above it.
	tunnel := tunnelConn{Conn: websocket.NetConn(ctx, conn, websocket.MessageBinary), ws: conn}
	return serveTunnel(ctx, tunnel, newLocalProxy(m.backendPort, m.frontendPort, newPreviewSite(cfg), previewAuth{password: m.config.Password, guard: m.config.PasswordGuard, sessions: m.config.Sessions, tickets: m.config.Tickets}, m.log), m.log)
}

// dialUplink reports a rejected token as ErrInvalidToken, which is what the
// reconnect loop tells apart from a connection that merely failed.
func (m *Manager) dialUplink(ctx context.Context, url, relayToken string) (*websocket.Conn, error) {
	conn, resp, err := websocket.Dial(ctx, url, m.uplinkDialOptions(relayToken))
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return nil, fmt.Errorf("relay rejected relay_token: %w: %w", ErrInvalidToken, err)
		}
		return nil, fmt.Errorf("dial: %w", err)
	}
	return conn, nil
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
	m.remoteURLMu.Lock()
	defer m.remoteURLMu.Unlock()
	return m.remoteURL
}

func (m *Manager) setRemoteURL(url string) {
	m.remoteURLMu.Lock()
	defer m.remoteURLMu.Unlock()
	m.remoteURL = url
}

func buildRemoteURL(cfg *StoredConfig) string {
	return fmt.Sprintf("https://%s.%s", cfg.Subdomain, cfg.RelayServer)
}

func buildRelayWSURL(cfg *StoredConfig) string {
	return fmt.Sprintf("wss://%s.%s/relay", cfg.Subdomain, cfg.RelayServer)
}
