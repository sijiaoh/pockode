// Package fuzzy matches and scores a query against texts the way fzf does.
// It is a pure algorithm with no IO, for any list a user narrows by typing.
//
// The matching, scoring and query syntax are ported from fzf
// (https://github.com/junegunn/fzf) and stay in the files that say so in their
// header, under fzf's MIT license: algo.go, chars.go, normalize.go, pattern.go
// and their tests algo_test.go, fastpath_test.go and pattern_test.go. Each
// header lists what was changed from the original. Everything else in the
// package is Pockode's own.
//
// A search parses the query once (ParsePattern, fzf's extended syntax with
// smart-case), picks a Scheme (DefaultScheme, PathScheme), and gives each
// goroutine its own Slab:
//
//	pattern := fuzzy.ParsePattern(query)
//	slab := fuzzy.NewSlab()
//	chars := fuzzy.ToChars([]byte(path))
//	score, positions, ok := pattern.Match(fuzzy.PathScheme, &chars, true, slab)
//
// The match functions on Scheme are the single-term building blocks under
// Pattern. Called directly, the pattern must already be lowercased when the
// match is case-insensitive and normalized (NormalizeRunes) when normalize is
// set.
package fuzzy
