package codex

import (
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

func codexAuthFailure() *agent.AuthFailure {
	return &agent.AuthFailure{Agent: session.AgentTypeCodex}
}

// unauthorizedErrorInfo is app-server's own name for a credentials refusal, in
// a turn error's codexErrorInfo. Where: the v2 schema of codex-cli 0.153.0.
const unauthorizedErrorInfo = "unauthorized"

// authVerdict is what one turn error's codexErrorInfo says about credentials.
type authVerdict int

const (
	// authUnknown: nothing either way — no status, or a name like "other".
	authUnknown authVerdict = iota
	// authRefused: the request was refused for its credentials.
	authRefused
	// authAccepted: the request got past authentication and failed for
	// something else, so an earlier refusal in the turn is no longer the story.
	authAccepted
)

// readAuthVerdict reads a turn error's codexErrorInfo.
//
// Two shapes, because the one the schema names is not the one a refused turn
// ends with: measured on codex-cli 0.153.0, signed out or with a rejected key,
// the turn retries its stream with `{"responseStreamDisconnected":
// {"httpStatusCode":401}}` on each attempt and then fails with plain "other".
// So a 401 on any variant counts, and "unauthorized" is kept for the version
// that starts using it. The status sits one level down, under the variant's
// name, which is why every variant is looked into rather than one named.
func readAuthVerdict(info json.RawMessage) authVerdict {
	if len(info) == 0 {
		return authUnknown
	}
	var name string
	if err := json.Unmarshal(info, &name); err == nil {
		if name == unauthorizedErrorInfo {
			return authRefused
		}
		return authUnknown
	}
	var variants map[string]struct {
		HTTPStatusCode *int `json:"httpStatusCode"`
	}
	if err := json.Unmarshal(info, &variants); err != nil {
		return authUnknown
	}
	verdict := authUnknown
	for _, v := range variants {
		switch {
		case v.HTTPStatusCode == nil:
		case *v.HTTPStatusCode == http.StatusUnauthorized:
			return authRefused
		default:
			verdict = authAccepted
		}
	}
	return verdict
}

// Secrets a Codex error can quote back. A rejected key is quoted in the
// provider's error ("Incorrect API key provided: sk-proj-****9jkl."): OpenAI
// masks the middle but keeps the prefix and the last four characters (measured
// on codex-cli 0.153.0), and another provider may not mask it at all. These
// texts go into the transcript and the log.
//
// A key ends at whitespace, a quote (the text may be a JSON body quoted whole)
// or the sentence's own punctuation, none of which a key of any provider here
// contains; what ends it is kept so the sentence still reads.
var (
	apiKeyProvidedPattern = regexp.MustCompile(`(?i)(api key provided:\s*["']?)[^\s,;"']+?(["']?[.,;]?(?:["'\s]|$))`)
	// Long enough to be a token, so prose like "Missing bearer or basic
	// authentication" — Codex's own words when signed out — is left alone.
	bearerPattern    = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*`)
	openAIKeyPattern = regexp.MustCompile(`\bsk-[A-Za-z0-9_*-]+`)
)

const redacted = "[redacted]"

// redactSecrets takes the credentials out of a Codex text: a key of any shape
// where the provider says it is quoting one, a bearer token, and an
// OpenAI-style key wherever else it turns up.
func redactSecrets(s string) string {
	s = apiKeyProvidedPattern.ReplaceAllString(s, "${1}"+redacted+"${2}")
	s = bearerPattern.ReplaceAllString(s, "${1}"+redacted)
	return openAIKeyPattern.ReplaceAllString(s, redacted)
}
