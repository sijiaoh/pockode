package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/pockode/server/localapi"
	"github.com/pockode/server/serverinfo"
)

// ErrLoginTicketUnsupported is a running node that cannot issue app login
// tickets: one started by a build that predates them. Its server.json has no
// token, or the node answers 404 (no such route) or 401 (its password
// middleware does not know the route and asks for the password).
var ErrLoginTicketUnsupported = errors.New("node cannot issue login tickets")

// loginTicketTimeout bounds the call to the node, which answers from memory: a
// node that takes longer is wedged, and the panel is waiting on a click.
const loginTicketTimeout = 10 * time.Second

// loginTicketBodyLimit caps what is read of the node's reply. A ticket is a
// few dozen bytes; anything near this is not a ticket.
const loginTicketBodyLimit = 4 << 10

// loginTicketClient never follows a redirect. The node never sends one, and
// following it would carry the token header to wherever it pointed.
var loginTicketClient = &http.Client{
	Timeout: loginTicketTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// LoginTicket asks n for a one-time app login ticket over its local API,
// authorised by the token in its server.json. It returns:
//   - ErrNodeNotRunning: no server.json, or its process is gone.
//   - ErrNodeRestarting: a restart this cluster asked for is under way.
//   - ErrLoginTicketUnsupported: a node too old to issue tickets.
//
// Any other error is a node that could not be reached or did not answer with
// a ticket, and says which.
func (pm *ProcessManager) LoginTicket(ctx context.Context, n Node) (string, error) {
	// One read for both the status and the token, so the token is the one of
	// the start the status is about.
	info, err := serverinfo.Read(nodeDataDir(n))
	switch pm.withRestart(n, info, fileStatus(n, info, err)).Status {
	case StatusRunning:
	case StatusRestarting:
		return "", ErrNodeRestarting
	default:
		return "", ErrNodeNotRunning
	}
	if info.Token == "" {
		return "", ErrLoginTicketUnsupported
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, info.LocalAPIBaseURL()+localapi.LoginTicketPath, nil)
	if err != nil {
		return "", fmt.Errorf("build login ticket request: %w", err)
	}
	req.Header.Set(localapi.TokenHeader, info.Token)

	resp, err := loginTicketClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach the node: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, loginTicketBodyLimit))
	if err != nil {
		return "", fmt.Errorf("could not read the node's reply: %w", err)
	}

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusNotFound:
		return "", ErrLoginTicketUnsupported
	default:
		return "", fmt.Errorf("the node answered %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var result localapi.LoginTicketResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("the node's reply is not a login ticket: %w", err)
	}
	if result.Ticket == "" {
		return "", errors.New("the node's reply carries no ticket")
	}
	return result.Ticket, nil
}
