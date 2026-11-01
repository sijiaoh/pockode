package selfinstall

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	// maxChecksumsSize bounds checksums.txt, which is one line per asset.
	maxChecksumsSize = 64 << 10
	// maxAssetSize bounds the download; a release executable is a few tens of
	// megabytes.
	maxAssetSize = 512 << 20
)

// checksum reads rel.AssetName's SHA-256 out of the release's checksums.txt.
func (in *Installer) checksum(ctx context.Context, rel Release) (string, error) {
	resp, err := in.get(ctx, rel.ChecksumsURL, "checksums.txt", FailureNoChecksums)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	sums, err := io.ReadAll(io.LimitReader(resp.Body, maxChecksumsSize+1))
	if err != nil {
		return "", fail(FailureDownload, "download checksums.txt: %w", err)
	}
	if len(sums) > maxChecksumsSize {
		return "", fail(FailureNoChecksums, "checksums.txt of %s is larger than %d bytes, which no release's is", rel.Version, maxChecksumsSize)
	}
	return findChecksum(sums, rel.AssetName, rel.Version)
}

// findChecksum reads asset's hash out of checksums.txt the way install.sh
// does: "<sha256>  <name>" as sha256sum and shasum write it, tolerating
// shasum's binary-mode "*" and CRLF line endings.
func findChecksum(sums []byte, asset, version string) (string, error) {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) != 2 || strings.TrimPrefix(fields[1], "*") != asset {
			continue
		}
		sum := strings.ToLower(fields[0])
		if b, err := hex.DecodeString(sum); err != nil || len(b) != sha256.Size {
			return "", fail(FailureNoChecksums, "checksums.txt of %s lists %s with %q, which is not a SHA-256", version, asset, fields[0])
		}
		return sum, nil
	}
	return "", fail(FailureNoAsset, "checksums.txt of %s does not list %s", version, asset)
}

// stage downloads rel's asset beside target, checks it against want and that
// it runs as rel.Version, and returns its path. The staged file is in target's
// directory so that the rename that replaces target stays on one file system,
// which is what makes it atomic. Nothing is left behind on an error.
func (in *Installer) stage(ctx context.Context, rel Release, target, want string, perm os.FileMode) (_ string, err error) {
	_, pattern := stagingPattern(target)
	f, err := os.CreateTemp(filepath.Dir(target), pattern)
	if err != nil {
		if isPermission(err) {
			return "", &UnavailableError{Reason: ReasonNotWritable, Dir: filepath.Dir(target), Err: err}
		}
		return "", fail(FailureDownload, "create a file for the download beside %s: %w", target, err)
	}
	staged := f.Name()
	defer func() {
		if err != nil {
			f.Close()
			in.discard(staged)
		}
	}()

	got, err := in.download(ctx, rel, f)
	if err != nil {
		return "", err
	}
	if got != want {
		return "", fail(FailureChecksumMismatch, "%s of %s does not match the checksum its release published: expected %s, got %s", rel.AssetName, rel.Version, want, got)
	}
	// The old executable's permissions, whatever the user chose for it;
	// CreateTemp's 0600 would not run.
	if err := f.Chmod(perm); err != nil {
		return "", fail(FailureDownload, "set permissions on the download: %w", err)
	}
	if err := f.Sync(); err != nil {
		return "", fail(FailureDownload, "write the download: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", fail(FailureDownload, "write the download: %w", err)
	}
	if err := checkVersion(ctx, staged, rel.Version); err != nil {
		return "", err
	}
	return staged, nil
}

// download writes rel's asset to w and returns its SHA-256.
func (in *Installer) download(ctx context.Context, rel Release, w io.Writer) (string, error) {
	resp, err := in.get(ctx, rel.AssetURL, rel.AssetName, FailureNoAsset)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(resp.Body, maxAssetSize+1))
	if err != nil {
		return "", fail(FailureDownload, "download %s: %w", rel.AssetName, err)
	}
	if n > maxAssetSize {
		return "", fail(FailureDownload, "download %s: larger than %d bytes", rel.AssetName, maxAssetSize)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// get fetches url, which is the release's file name. A 404 is notFound: the
// release does not have it — the Atom fallback of the release list builds
// URLs by convention, without knowing which assets exist.
func (in *Installer) get(ctx context.Context, url, name string, notFound Failure) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fail(FailureDownload, "download %s: %w", name, err)
	}
	req.Header.Set("User-Agent", in.userAgent)
	resp, err := in.client.Do(req)
	if err != nil {
		return nil, fail(FailureDownload, "download %s: %w", name, err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			return nil, fail(notFound, "the release has no %s (%s: %s)", name, url, resp.Status)
		}
		return nil, fail(FailureDownload, "download %s from %s: %s", name, url, resp.Status)
	}
	return resp, nil
}
