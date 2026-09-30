package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
)

// authTimeout bounds one Auth call from start to finish: the `--help` probe,
// the app-server's start and handshake, and every request made on it — for a
// sign-out, the account/read after it too.
//
// Measured on codex-cli 0.153.0: `initialize` 2.3-4.9s, and `account/read`
// 3-12s against a real CODEX_HOME — it reaches the network — so a read took up
// to about 17s. 45s leaves the same kind of margin startupTimeout does, for the
// same reason: a read cut short is paid again in full by the retry.
//
// The client waits for the reply, so its timeout for cli_auth.* has to stay
// above this one, with margin; see docs/code/cli-auth.md. Grow the two together.
const authTimeout = 45 * time.Second

// Auth is the cliauth.Provider for Codex.
//
// It speaks the app-server's account API rather than `codex login status`:
// app-server is already what Pockode drives Codex through, its answers are JSON,
// and they carry the account and plan, which the text command does not.
//
// Every call starts an app-server of its own and ends it. The one a session is
// using cannot be asked: it caches the account it read at startup, so it still
// answered "signed out" after new credentials were written under it (measured),
// even though its next turn used them.
type Auth struct {
	log *slog.Logger
	// binary is the executable run; Binary everywhere but in tests, which put a
	// fake app-server in its place.
	binary string
	// workDir is where the app-server runs. A trusted project's
	// .codex/config.toml can choose a model provider that needs no OpenAI sign-in,
	// so the answer depends on it: it has to be read where the sessions run.
	workDir string
}

func NewAuth(workDir string) *Auth {
	return &Auth{log: slog.With("cli", Binary), binary: Binary, workDir: workDir}
}

func (a *Auth) Binary() string { return a.binary }

func (a *Auth) Status(ctx context.Context) (cliauth.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	c, err := a.start(ctx)
	if err != nil {
		return cliauth.Status{}, err
	}
	defer c.close()
	return a.read(ctx, c)
}

// Logout signs out and reads the result on the same app-server: one start and
// one handshake instead of two, which is most of the time either takes. Asking
// the process that did the sign-out is safe where asking a session's is not —
// the cache that makes a session's answer stale is the one this sign-out has
// just updated. Measured: after account/logout, the same app-server's
// account/read answered account null.
func (a *Auth) Logout(ctx context.Context) (cliauth.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	c, err := a.start(ctx)
	if err != nil {
		return cliauth.Status{}, fmt.Errorf("codex sign-out failed: %w", err)
	}
	defer c.close()

	if _, err := c.call(ctx, "account/logout", map[string]any{}); err != nil {
		return cliauth.Status{}, fmt.Errorf("codex sign-out failed: %w", cliauth.TimeoutError(ctx, err, "codex account/logout", authTimeout))
	}
	st, err := a.read(ctx, c)
	if err != nil {
		return cliauth.ErrorStatus(err), nil
	}
	return st, nil
}

func (a *Auth) start(ctx context.Context) (*authClient, error) {
	c, err := startAuthClient(ctx, ctx, a.log, a.binary, a.workDir)
	if err != nil {
		return nil, cliauth.TimeoutError(ctx, err, "starting the codex app-server", authTimeout)
	}
	return c, nil
}

func (a *Auth) read(ctx context.Context, c *authClient) (cliauth.Status, error) {
	// refreshToken stays off: reading the status is not the moment to rewrite
	// the credential file.
	result, err := c.call(ctx, "account/read", map[string]any{})
	if err != nil {
		return cliauth.Status{}, cliauth.TimeoutError(ctx, err, "codex account/read", authTimeout)
	}
	return parseAccount(result)
}

// getAccountResponse is account/read's answer. requiresOpenaiAuth is a pointer
// so that an answer without it is told apart from one saying false.
type getAccountResponse struct {
	Account            *codexAccount `json:"account"`
	RequiresOpenaiAuth *bool         `json:"requiresOpenaiAuth"`
}

type codexAccount struct {
	Type     string `json:"type"`
	Email    string `json:"email"`
	PlanType string `json:"planType"`
}

// Codex's account types, as of codex-cli 0.153.0.
const (
	accountTypeChatGPT       = "chatgpt"
	accountTypeAPIKey        = "apiKey"
	accountTypeAmazonBedrock = "amazonBedrock"
)

// planUnknown is what Codex reports when it has no plan to name; it says nothing
// a user could read, so it is left out rather than shown.
const planUnknown = "unknown"

// parseAccount reads account/read's answer.
//
// requiresOpenaiAuth comes first: a Codex configured for a provider that does
// not use OpenAI's sign-in runs no differently whatever account is stored, so
// that account is not what the user needs to hear about.
//
// OPENAI_API_KEY and CODEX_API_KEY need no case of their own. The app-server
// does not read them — an unsigned-in app-server with either set still failed
// its turn for missing authentication (measured) — so "signed out" here is the
// truth for every Pockode session.
func parseAccount(result json.RawMessage) (cliauth.Status, error) {
	var resp getAccountResponse
	if err := json.Unmarshal(result, &resp); err != nil {
		return cliauth.Status{}, fmt.Errorf("codex account/read answered in a shape Pockode cannot read: %w", err)
	}
	if resp.RequiresOpenaiAuth == nil {
		return cliauth.Status{}, errors.New("codex account/read did not say whether OpenAI sign-in is required; this Codex version may report accounts differently than Pockode expects")
	}

	if !*resp.RequiresOpenaiAuth {
		return cliauth.ExternalStatus(cliauth.External{Kind: cliauth.ExternalNoSignInNeeded}), nil
	}
	if resp.Account == nil {
		return cliauth.Status{State: cliauth.StateSignedOut}, nil
	}

	switch acct := resp.Account; acct.Type {
	case accountTypeChatGPT:
		plan := acct.PlanType
		if plan == planUnknown {
			plan = ""
		}
		return cliauth.Status{
			State:   cliauth.StateSignedIn,
			Account: &cliauth.Account{Email: acct.Email, Plan: plan},
		}, nil
	case accountTypeAPIKey:
		return cliauth.ExternalStatus(cliauth.External{Kind: cliauth.ExternalAPIKey}), nil
	case accountTypeAmazonBedrock:
		return cliauth.ExternalStatus(cliauth.External{Kind: cliauth.ExternalCloudProvider, Provider: "bedrock"}), nil
	default:
		return cliauth.ExternalStatus(cliauth.External{Kind: cliauth.ExternalOther, Method: acct.Type}), nil
	}
}

// authClient is a short-lived app-server for account calls: started, asked one
// thing at a time, closed.
//
// It is not appSession, which is built around a thread and its event stream and
// would have to be half-constructed to be used for this. What the two share —
// the message types and the handshake parameters — is shared.
type authClient struct {
	log    *slog.Logger
	proc   *agent.Process
	cancel context.CancelFunc

	nextID int64
	// waitingFor is the id of the call waiting for its reply, or 0. readLoop
	// hands over that reply alone: blocking on one nobody waits for would stop
	// it reading the notification a sign-in is waiting on.
	waitingFor atomic.Int64
	// replies holds the reply to the call waiting. It has room for more than
	// one so that a late reply to a call that gave up, landing as the next call
	// starts, cannot crowd out that call's own.
	replies chan rpcMessage
	// loginCompleted receives account/login/completed, the one notification
	// anything here waits for. Buffered, and sent to without blocking: a client
	// runs at most one sign-in, whose waiter skips completions naming another,
	// and a client that runs none never reads it.
	loginCompleted chan loginCompletedNotification
	// readDone is closed once stdout reaches EOF: the app-server is gone, and
	// nothing it has not answered yet will be.
	readDone chan struct{}
	stderr   <-chan string
}

// startAuthClient starts an app-server that lives until procCtx is done or the
// client is closed, and completes its handshake within callCtx. The two differ
// for a sign-in, whose app-server has to outlast the budget its start is given.
func startAuthClient(procCtx, callCtx context.Context, log *slog.Logger, binary, workDir string) (*authClient, error) {
	if err := checkAppServerSupport(callCtx, binary); err != nil {
		return nil, err
	}

	procCtx, cancel := context.WithCancel(procCtx)
	proc, err := agent.StartProcess(procCtx, log, binary, []string{appServerSubcommand}, workDir)
	if err != nil {
		cancel()
		return nil, err
	}

	c := &authClient{
		log:            log,
		proc:           proc,
		cancel:         cancel,
		replies:        make(chan rpcMessage, 4),
		readDone:       make(chan struct{}),
		loginCompleted: make(chan loginCompletedNotification, 8),
		stderr:         agent.ReadStderr(proc.Stderr, "codex"),
	}
	go c.readLoop(proc.Stdout)

	if _, err := c.call(callCtx, "initialize", initializeParams()); err != nil {
		c.close()
		return nil, fmt.Errorf("codex app-server handshake failed: %w", err)
	}
	if err := c.write(initializedNotification); err != nil {
		c.close()
		return nil, fmt.Errorf("codex app-server handshake failed: %w", err)
	}
	return c, nil
}

// readLoop hands replies to the caller waiting in call. Notifications are
// dropped but for the end of a sign-in: the calls made here are answered in
// their reply. Requests from the app-server are not expected — they are about
// turns, and no turn runs here.
func (c *authClient) readLoop(stdout io.Reader) {
	defer close(c.readDone)

	scanner := agent.NewLineScanner(stdout, agent.MaxLineBytes)
	for scanner.Scan() {
		if scanner.Truncated() || len(scanner.Bytes()) == 0 {
			continue
		}
		var msg rpcMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			c.log.Warn("failed to parse JSON-RPC from codex", "error", err, "lineLength", scanner.Len())
			continue
		}
		if msg.Method == methodLoginCompleted {
			c.deliverLoginCompleted(msg.Params)
			continue
		}
		if msg.ID == nil || msg.Method != "" || *msg.ID != c.waitingFor.Load() {
			continue
		}
		select {
		case c.replies <- msg:
		default:
		}
	}
	if err := scanner.Err(); err != nil {
		c.log.Error("stdout scanner error", "error", err)
	}
}

func (c *authClient) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	paramsData, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	c.nextID++
	id := c.nextID
	// Replies to earlier calls that gave up before reading them.
drain:
	for {
		select {
		case <-c.replies:
		default:
			break drain
		}
	}
	c.waitingFor.Store(id)
	defer c.waitingFor.Store(0)
	if err := c.write(rpcRequest{JSONRPC: "2.0", ID: &id, Method: method, Params: paramsData}); err != nil {
		return nil, fmt.Errorf("send %s to codex: %w", method, err)
	}

	answer := func(msg rpcMessage) (json.RawMessage, error) {
		if msg.Error != nil {
			return nil, callError(method, msg.Error)
		}
		return msg.Result, nil
	}
	for {
		select {
		case msg := <-c.replies:
			if *msg.ID == id {
				return answer(msg)
			}
		case <-c.readDone:
			// An answer read just before the exit is still the answer.
			for {
				select {
				case msg := <-c.replies:
					if *msg.ID == id {
						return answer(msg)
					}
					continue
				default:
				}
				return nil, c.exitError(method)
			}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// methodNotFound is JSON-RPC's "no such method".
const methodNotFound = -32601

// accountCallError is a JSON-RPC error the app-server answered a call with.
type accountCallError struct {
	method string
	rpc    *rpcError
}

func (e *accountCallError) Error() string {
	if e.rpc.Code == methodNotFound {
		return fmt.Sprintf("this codex CLI does not support %s, which Pockode needs to read and change its sign-in; update codex and try again", e.method)
	}
	return fmt.Sprintf("codex %s: %s", e.method, e.rpc.Message)
}

func callError(method string, err *rpcError) error {
	return &accountCallError{method: method, rpc: err}
}

// exitError says the app-server went away before answering, with the last thing
// it wrote to stderr — which is where it says why.
func (c *authClient) exitError(method string) error {
	var stderr string
	select {
	case stderr = <-c.stderr:
	case <-time.After(agent.StderrReadTimeout):
	}
	if line := agent.LastLine(stderr); line != "" {
		return fmt.Errorf("codex app-server exited before answering %s: %s", method, line)
	}
	return fmt.Errorf("codex app-server exited before answering %s", method)
}

func (c *authClient) write(msg rpcRequest) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = c.proc.Stdin.Write(append(data, '\n'))
	return err
}

// close ends the app-server and its whole process tree. Nothing it has to say
// is still wanted, so it is not asked to exit on its own first.
func (c *authClient) close() {
	c.cancel()
	<-c.readDone
	c.proc.OutputDone()
	if err := c.proc.Wait(); err != nil {
		c.log.Debug("codex app-server for an account call ended", "error", err)
	}
}
