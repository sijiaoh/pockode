package middleware

import (
	"crypto/subtle"
	"net/http"
)

func Auth(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Endpoints that bypass auth
			switch r.URL.Path {
			case "/health", "/ws", "/api/login", "/api/logout":
				next.ServeHTTP(w, r)
				return
			}

			cookieToken := GetTokenFromCookie(r)
			if cookieToken != "" && subtle.ConstantTimeCompare([]byte(cookieToken), []byte(token)) == 1 {
				next.ServeHTTP(w, r)
				return
			}

			http.Error(w, "Unauthorized", http.StatusUnauthorized)
		})
	}
}
