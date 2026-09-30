package cliupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// NPMRegistry is the public npm registry, where both CLIs publish every release.
const NPMRegistry = "https://registry.npmjs.org"

// latestTimeout bounds one read of a package's dist-tags: a document of a few
// hundred bytes. It runs beside `--version` (10s), not after it, so a check
// fits the client's default RPC timeout (30s).
const latestTimeout = 10 * time.Second

// maxDistTagsSize caps what is read of a dist-tags response. Codex's, the
// larger of the two with a tag per platform, is under 1 KiB.
const maxDistTagsSize = 64 << 10

// registryClient reads what version a package's dist-tag points at.
type registryClient struct {
	baseURL string
	http    *http.Client
}

// latest returns the version pkg's tag points at.
func (r registryClient) latest(ctx context.Context, pkg, tag string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, latestTimeout)
	defer cancel()

	// The package name goes in as it is, scope slash included: the registry
	// takes it that way, and the names are this package's own constants.
	u := r.baseURL + "/-/package/" + pkg + "/dist-tags"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := r.http.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", fmt.Errorf("reading the latest %s from %s did not finish in time: %w", pkg, r.baseURL, err)
		}
		return "", fmt.Errorf("read the latest %s from %s: %w", pkg, r.baseURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("read the latest %s from %s: %s", pkg, r.baseURL, resp.Status)
	}

	var tags map[string]string
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxDistTagsSize)).Decode(&tags); err != nil {
		return "", fmt.Errorf("read the latest %s from %s: %w", pkg, r.baseURL, err)
	}
	v, ok := tags[tag]
	if !ok {
		return "", fmt.Errorf("%s has no %q release on %s", pkg, tag, r.baseURL)
	}
	return v, nil
}
