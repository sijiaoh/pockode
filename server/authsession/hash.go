package authsession

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
)

// The password fingerprint parameters. PBKDF2-HMAC-SHA256 at OWASP's 2023
// recommended iteration count, with the algorithm and iteration count written
// into the file so that a future change of KDF does not have to guess how an
// existing record was computed.
const (
	kdfAlgo       = "pbkdf2-sha256"
	kdfIterations = 600_000
	kdfSaltLen    = 16
	kdfKeyLen     = 32
)

// passwordHash is a fingerprint of the server's password, kept only so that a
// changed password can be detected at startup and every session issued under
// the old one invalidated. It is never part of an online authentication check —
// the password itself is in memory there, so a slow KDF would buy nothing and
// cost a few hundred milliseconds per request.
type passwordHash struct {
	Algo       string `json:"algo"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"`
	Hash       string `json:"hash"`
}

func derivePasswordHash(password string) (*passwordHash, error) {
	salt := make([]byte, kdfSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, kdfIterations, kdfKeyLen)
	if err != nil {
		return nil, err
	}
	return &passwordHash{
		Algo:       kdfAlgo,
		Iterations: kdfIterations,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Hash:       base64.StdEncoding.EncodeToString(key),
	}, nil
}

// maxKdfIterations bounds the iteration count read back from the file. Startup
// blocks on this derivation, so an absurd count — a corrupted file, or one
// written by a future build with a much heavier default — would hang the only
// path into the server with no output saying why. Anything above the bound is
// refused like an unknown algorithm: the fingerprint is re-derived and the
// sessions dropped, which costs a re-login and nothing else.
const maxKdfIterations = 10 * kdfIterations

// matches reports whether password is the one this fingerprint was derived
// from. A fingerprint written by an unknown algorithm, or one that fails to
// decode, is treated as "not this password", which makes the caller re-derive
// it and drop the sessions — the same, safe path a real password change takes.
func (p *passwordHash) matches(password string) bool {
	if p == nil || p.Algo != kdfAlgo {
		return false
	}
	if p.Iterations <= 0 || p.Iterations > maxKdfIterations {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(p.Salt)
	if err != nil {
		return false
	}
	// A zero-length stored hash would make ConstantTimeCompare below return 1
	// for every password, so the length is pinned rather than taken from the
	// file.
	want, err := base64.StdEncoding.DecodeString(p.Hash)
	if err != nil || len(want) != kdfKeyLen {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, p.Iterations, kdfKeyLen)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}
