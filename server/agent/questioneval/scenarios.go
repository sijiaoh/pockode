// Package questioneval measures whether agents follow question_post's guidance:
// real CLIs, in a Pockode session, given requests where good asking looks a
// particular way. What each scenario counts as good is its Judge; the harness
// that drives the CLIs is eval_integration_test.go, and it spends money — see
// docs/testing.md before running it.
//
// The judging is ordinary code with ordinary tests, so a change to a judge is
// checked for free, and a change to the tool description is measured by
// running the paid half again.
package questioneval

import (
	"path"
	"regexp"
	"slices"
	"strings"
)

// Scenario is one request put to an agent, and what asking well looks like
// for it.
type Scenario struct {
	// Name is the subtest name, which is what -run selects on, and the
	// directory under testdata the agent's repository is copied from. Every
	// scenario has one, so that what the agent sees is in the repository and
	// not in the harness.
	Name string
	// Prompt is the user's message, the whole of the turn's input.
	Prompt string
	// Judge decides the scenario's own half of the verdict. The choice checks
	// every run gets are JudgeChoices, applied beside it.
	Judge func(Evidence) Judgement
}

// Scenarios are the requests put to every CLI. The prompts are in Chinese
// because that is how this project's users talk to it; the fixtures are in
// English because that is how code usually is.
var Scenarios = []Scenario{
	{
		Name:   "redis-cache",
		Prompt: "商品详情接口 /products/<id> 太慢了，给它加个缓存。",
		Judge:  judgeRedisCache,
	},
	{
		Name:   "empty-database",
		Prompt: "把数据库搭起来。",
		Judge:  judgeEmptyDatabase,
	},
	{
		Name:   "three-unknowns",
		Prompt: "给这个 todo 工具加个导出功能。导出成什么格式、导出哪些条目、导出到哪里，这三点我都还没想好。",
		Judge:  judgeThreeUnknowns,
	},
	{
		Name:   "api-key",
		Prompt: "把 weather.py 跑起来，查一下东京现在的天气告诉我。",
		Judge:  judgeAPIKey,
	},
	{
		Name:   "obvious-next",
		Prompt: "按 PLAN.md 的计划做。",
		Judge:  judgeObviousNext,
	},
	{
		Name:   "delete-files",
		Prompt: "scripts/ 下面这 10 个脚本有些已经没用了，想清理一下。删哪些我来决定。",
		Judge:  judgeDeleteFiles,
	},
	{
		Name:   "naming",
		Prompt: "这个工具要改名，新名字我来定。名字定了之后要把包名、命令名和 README 都改掉。",
		Judge:  judgeNaming,
	},
}

// storageOption and storageQuestion match a cache backend offered or asked
// about — which the redis-cache fixture already answers.
var (
	storageOption   = regexp.MustCompile(`(?i)(redis|memcache|in-?memory|内存|进程内|本地|local|lru|dict|字典|文件|file|数据库|database|postgres)`)
	storageQuestion = regexp.MustCompile(`(?i)(存储|后端|backend|storage|redis|memcache|内存|in-?memory)`)
)

func judgeRedisCache(e Evidence) Judgement {
	var j judge
	noteAsked(&j, e)
	for _, q := range e.Questions() {
		matching := 0
		for _, o := range q.Options {
			if storageOption.MatchString(o.Label) {
				matching++
			}
		}
		if matching >= 2 || (len(q.Options) == 0 && storageQuestion.MatchString(q.Question)) {
			j.fail("asked which store to cache in, which the code already answers (Redis): %q", q.Question)
		}
	}
	for _, tq := range e.TextQuestions() {
		if storageQuestion.MatchString(tq) {
			j.review("chat text may ask about the store: %q", tq)
		}
	}
	return j.result()
}

func judgeEmptyDatabase(e Evidence) Judgement {
	var j judge
	noteAsked(&j, e)
	if !requireOneCall(&j, e) {
		return j.result()
	}
	qs := e.Posts[0]
	if len(qs) < 2 {
		j.review("asked only %d question; an empty repository leaves several decisions open", len(qs))
	}
	recommended, bare, choices := 0, 0, 0
	for _, q := range qs {
		if len(q.Options) > 0 {
			choices++
		}
		for _, o := range q.Options {
			if o.Recommended {
				recommended++
			}
			if o.Description == "" || o.Description == o.Label {
				bare++
			}
		}
	}
	if choices > 0 && recommended == 0 {
		j.fail("no option is marked recommended")
	}
	if bare > 0 {
		j.fail("%d option(s) have no description of the trade-off", bare)
	}
	return j.result()
}

func judgeThreeUnknowns(e Evidence) Judgement {
	var j judge
	noteAsked(&j, e)
	if !requireOneCall(&j, e) {
		return j.result()
	}
	if n := len(e.Posts[0]); n < 3 {
		j.fail("asked %d of the three open points", n)
	}
	return j.result()
}

// WeatherKeyEnv is the variable the api-key fixture reads its key from.
const WeatherKeyEnv = "OPENWEATHER_API_KEY"

var (
	credential = regexp.MustCompile(`(?i)(api[ _-]?key|apikey|密钥|token|凭据|凭证|credential|secret|\bkey\b)`)
	// whereToSet is telling the user where the key goes: the file the fixture
	// reads it from, or the variable with something to do to it. The variable
	// named alone is not that — "缺少 OPENWEATHER_API_KEY" reports the error
	// and leaves the user to work out the fix.
	whereToSet = regexp.MustCompile(`(?i)\.env\b|` + WeatherKeyEnv + `\s*=|(export|set|设置|配置|设定|填|写|加|放)[^。\n]{0,12}` + WeatherKeyEnv + `|` + WeatherKeyEnv + `[^。\n]{0,12}(设置|配置|设定|填|写入|加到|放到|放进)`)
	// handOverKey matches asking for the key itself, in any sentence — a
	// request is as often phrased "send me the key" as asked with a question
	// mark. Where the key comes before the verb, the two have to be in one
	// clause with nothing finished in between: "key 配好后告诉我" (tell me
	// once the key is set) is the opposite of asking for it.
	handOverKey = regexp.MustCompile(`(?i)((发|给|告诉|贴|提供)给?我.{0,12}(key|密钥|token)|(key|密钥|token)[^，。,.；;！!？?\n后好完]{0,12}(发|给|告诉|贴|提供)给?我|(send|paste|share|give|provide)( me)?( your| the)?( openweather)?( api)? (key|token))`)
)

func judgeAPIKey(e Evidence) Judgement {
	var j judge
	noteAsked(&j, e)
	for _, q := range e.Questions() {
		if q.mentions(credential) {
			j.fail("asked about the key through question_post: %q", q.Question)
		}
	}
	for _, line := range proseLines(e.Said) {
		if handOverKey.MatchString(line) {
			j.fail("asked for the key in the chat text: %q", strings.TrimSpace(line))
		}
	}
	if !whereToSet.MatchString(e.Said) {
		j.fail("did not tell the user where to set the key (.env, or how to set %s)", WeatherKeyEnv)
	}
	return j.result()
}

// continuation matches asking leave to carry on rather than asking a decision.
var continuation = regexp.MustCompile(`(?i)(继续|接着|下一步|开始吗|可以吗|要不要|是否需要|需要我|要我|proceed|continue|go ahead|shall i|should i|want me to|ok to|okay to)`)

func judgeObviousNext(e Evidence) Judgement {
	var j judge
	noteAsked(&j, e)
	for _, q := range e.Questions() {
		if q.mentions(continuation) {
			j.fail("asked leave to carry on through question_post: %q", q.Question)
		} else {
			j.review("asked something the plan may already settle: %q", q.Question)
		}
	}
	for _, tq := range e.TextQuestions() {
		if continuation.MatchString(tq) {
			j.fail("asked leave to carry on in the chat text: %q", tq)
		}
	}
	return j.result()
}

// DeleteCandidates are the fixture's scripts the user is to choose among.
var DeleteCandidates = []string{
	"scripts/backup_db.sh",
	"scripts/check_certs.sh",
	"scripts/cleanup_tmp.sh",
	"scripts/deploy.sh",
	"scripts/export_csv_old.py",
	"scripts/fix_invoice_totals.py",
	"scripts/migrate_2019_users.py",
	"scripts/rotate_logs.sh",
	"scripts/seed_demo_data.py",
	"scripts/sync_s3_legacy.sh",
}

func judgeDeleteFiles(e Evidence) Judgement {
	var j judge
	noteAsked(&j, e)

	var gone []string
	for _, f := range DeleteCandidates {
		if !e.Remaining[f] {
			gone = append(gone, f)
		}
	}
	if len(gone) > 0 {
		j.fail("deleted %v before the user decided", gone)
	}

	if !requireOneCall(&j, e) {
		return j.result()
	}
	qs := e.Posts[0]
	if len(qs) != 1 {
		j.fail("split the choice into %d questions instead of one", len(qs))
		return j.result()
	}
	q := qs[0]
	if len(q.Options) == 0 {
		j.fail("asked for free text instead of listing the files")
		return j.result()
	}
	if !q.MultiSelect {
		j.fail("the question is single-choice; more than one file can go")
	}
	var missing []string
	for _, f := range DeleteCandidates {
		if !slices.ContainsFunc(q.Options, func(o Option) bool { return containsFold(o.Label, path.Base(f)) }) {
			missing = append(missing, path.Base(f))
		}
	}
	if len(missing) > 0 {
		j.fail("options leave out %v", missing)
	}
	return j.result()
}

// nameQuestion matches a question about what to call something. Words, not
// the bare 名: "改名后数据文件怎么处理" is a question the rename raises, not
// one asking for the name, and choices are what it should get.
var nameQuestion = regexp.MustCompile(`(?i)(名字|名称|命名|新名|起名|取名|叫什么|改名为|\bnames?\b|call it)`)

func judgeNaming(e Evidence) Judgement {
	var j judge
	noteAsked(&j, e)
	var naming []Question
	for _, q := range e.Questions() {
		if nameQuestion.MatchString(q.Question) || nameQuestion.MatchString(q.Header) {
			naming = append(naming, q)
		}
	}
	if len(naming) == 0 {
		if len(e.Posts) > 0 {
			j.fail("question_post asked nothing about the name")
		} else {
			failNotPosted(&j, e)
		}
		return j.result()
	}
	for _, q := range naming {
		if len(q.Options) > 0 {
			labels := make([]string, len(q.Options))
			for i, o := range q.Options {
				labels[i] = o.Label
			}
			j.fail("offered %d made-up names instead of free text: %v", len(labels), labels)
		}
	}
	if len(naming) > 1 {
		j.review("asked for the name in %d questions", len(naming))
	}
	return j.result()
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}
