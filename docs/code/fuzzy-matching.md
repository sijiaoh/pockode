# Fuzzy Matching

`server/fuzzy` matches and scores a typed query against texts the way fzf does:
fzf's matching and scoring algorithms, and its extended search syntax with
smart-case. It is pure computation with no IO, written for any list a user
narrows by typing: file paths, session titles, work items. It does not list
candidates, rank them or cap them. Those jobs belong to the caller, because they
differ from one list to the next.

The package's API, the query syntax and the contract of each function are in
its Go doc (`server/fuzzy/doc.go`, `Pattern`, `Scheme`, `Slab`, `Algo`). This
document explains why the package has that shape and what a caller has to get
right when wiring it in.

Its caller is `file.search`'s name mode ([docs/file.md](../file.md#search-behavior)).
Content mode still matches a literal substring through `server/search`'s own
matcher, which stays the right tool there: a line of a file does not want
fuzzy subsequence matching, and its ASCII fast path is what makes scanning a
whole repository affordable.

## Why a Port and Not a Dependency

fzf's algorithms are importable, but they keep their scoring scheme in package
state: `algo.Init("path")` rewrites globals that every later match reads. One
process could then score with only one scheme at a time, and switching schemes
would race with any search still running. Pockode wants path scoring for files
and default scoring for titles, both possibly at once on behalf of different
clients. The global state is the whole reason this is a port. It also showed up
in practice: the check against real fzf (below) had to run in one process per
scheme, because `Init` does not reset what an earlier call set.

Everything else in the port exists to keep results the same as fzf's. Users
already know how fzf ranks, and it was tuned on real file systems. The changes
are listed in each ported file's header, and fall into three kinds:

- **State became values.** A `Scheme` is an immutable value the caller passes
  in. Its per-scheme lookup tables are computed once, when `DefaultScheme` and
  `PathScheme` are built. fzf's test hooks became a parameter, so the package
  has no mutable global at all.
- **Cut to what Pockode uses.** Only the extended mode is kept, with fzf's
  defaults fixed: fuzzy terms, FuzzyMatchV2, smart-case, normalization, forward
  scanning. The history scheme, `--exact`, `--nth`, the case options and the
  result cache are gone, along with the features they served.
- **Performance-only code left out.** The SIMD scans (replaced by fzf's own pure
  Go fallback), the prefilter for non-ASCII text and the debug dump are gone.
  None of them changes a result. The cost is that a non-ASCII text is always
  scanned in full.

One difference does change a result. `PathScheme` treats only `/` as a path
delimiter, on every platform, where fzf on Windows adds `\`. Every path
Pockode's APIs carry uses `/`, so this makes a Windows server rank exactly like
the others. fzf's pathname tiebreak (below) also counts `\` as a delimiter.
Leave that out too if you port it.

### How Fidelity Was Checked

fzf's own tests for the ported files were ported with them and run in CI. On
top of those, each port was compared once against the real fzf module in a
throwaway module outside the repository: 400,000 random cases for the
algorithms and 300,000 for the query syntax, across both schemes and every
option. Score, span and positions agreed in every case. That harness is not
kept, because it would need fzf as a dependency. When moving to a newer fzf,
diff the upstream files listed in each header between the two versions, carry
the change over, update the version in the headers, and repeat the comparison
the same way.

## Third-Party Code

The ported files stay under fzf's MIT license, and each one says so itself.
Its header names the fzf version and source file, lists what changed, and
carries fzf's copyright and full permission notice. The package doc lists which
files those are. Everything else in the package is Pockode's own.

Keep the boundary at the file level. A ported function belongs in a file with
that header, never in one of Pockode's own files. New Pockode code stays out of
the ported files, unless it is a change to ported code, which then goes into
the header's list. Then "which code is fzf's" never needs more than a look at
the file headers, and the MIT notice travels with every copy of the code it
covers.

## Wiring It In

### What Is Shared and What Is Not

The three inputs of `Pattern.Match` differ in who may share them, and that is
deliberate:

| Value | Lifetime | Shared across goroutines |
|-------|----------|--------------------------|
| `*Pattern` | One per query (`ParsePattern`) | Yes, it is immutable |
| `*Scheme` | Package values | Yes, they are immutable |
| `*Slab` | One per goroutine (`NewSlab`) | **No** |

A slab is FuzzyMatchV2's scoring matrix, kept so that scoring thousands of
texts does not allocate a matrix for each. That buffer is why it cannot be
shared: two goroutines would write the same matrix. Allocate one per worker
goroutine and reuse it for every text that worker scores. A `nil` slab is
allowed and allocates on every call, which suits a one-off match, not a loop.

The slab's size also bounds the cost of a long text. When the text is too long
for the matrix to fit, V2 falls back to the greedy FuzzyMatchV1, which is linear
but does not always find the best-scoring alignment. With a `nil` slab there is
no fallback for text length, and the work grows with text length × query
length. If a caller might score long texts, give it a slab.

`ToChars` keeps an ASCII text's bytes without copying them, so do not reuse
that byte buffer for the next text while the `Chars` is still being matched.

### Picking a Scheme

`PathScheme` is for slash-separated paths. A match right after `/`, or at the
start of the path, counts as the start of a component and earns more than a
match after a space. `DefaultScheme` is for free text such as titles, and
gives its biggest bonus after whitespace instead. Pick the scheme from what
the text is, not from the screen it appears on. The tests in
`server/fuzzy/match_test.go` (`TestPatternScheme`) show the two ranking
`aa/bb` and `aa bb` in opposite order.

### Ranking Is the Caller's

`Match` returns the score of one text, which is fzf's total score: the sum of
the positive terms' scores. fzf also breaks ties, and that is left to the
caller because it depends on the list. To rank like fzf, sort by score
descending, then:

- with `PathScheme`, by **pathname**: a match that starts in the basename
  beats one that starts in a directory name, and among basename matches the
  one starting closer to the last `/` wins. The start is the first of the
  sorted positions, so this needs `withPos`;
- then, with either scheme, by **length**: the shorter text wins, counted in
  runes without leading and trailing whitespace;
- finally, by the list's own order.

These come from fzf's `parseScheme` (`src/options.go`) and
`buildResultFromBounds` (`src/result.go`), in the version named in the headers
of the ported files.

An empty query (`IsEmpty`) matches every text with score 0. Decide what the
list shows then, such as its natural order or nothing at all, and skip the
sort. Sorting would rank the whole list by the tiebreaks alone, shortest text
first, which is rarely the order the list wants.

### Positions and the Wire

`Match` returns positions as rune indices, sorted and without duplicates. An
exact, prefix, suffix or equal term contributes its whole span. The individual
`Algo` functions are lower level: their positions are unsorted (V2 returns
them backwards) and the exact algorithms return none, so call them directly
only if you merge positions the way `Match` does.

A rune here is what `for range` over the Go string yields, so an invalid UTF-8
byte counts as one rune. That is also how Go's `encoding/json` treats such a
byte: it writes one U+FFFD in its place. So the text a client receives has
exactly one character per rune index, and the indices stay valid even on
malformed text. `file.search` relies on the same substitution for its ranges
([docs/file.md](../file.md#operations), `file.search`).

A JavaScript client indexes strings in UTF-16 code units, so convert before
sending. Walk the text's runes, keep a running UTF-16 offset that grows by 2
for a rune above U+FFFF and by 1 otherwise, and map each position as it passes.
That takes one pass, because the positions are sorted. Do the conversion in
the layer that hands results to the wire, not in this package: the unit belongs
to the wire, and a Go caller wants runes. Positions are single characters, not
ranges, so a highlighter that wants ranges merges consecutive ones.
`file.search` does both in `server/search` (`positionsToByteRanges`,
`toClientText`) as its results leave the package.
