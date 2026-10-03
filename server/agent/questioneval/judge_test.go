package questioneval

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func post(qs ...Question) ToolCall {
	args, _ := json.Marshal(map[string]any{"questions": qs})
	return ToolCall{Tool: "question_post", Arguments: args, Result: "Posted"}
}

func choice(header string, labels ...string) Question {
	q := Question{Header: header, Question: header + "?"}
	for _, l := range labels {
		q.Options = append(q.Options, Option{Label: l, Description: "because " + l})
	}
	return q
}

func allFiles() map[string]bool {
	files := map[string]bool{}
	for _, f := range DeleteCandidates {
		files[f] = true
	}
	return files
}

func TestNewEvidence_RefusedCallsAreNotCalls(t *testing.T) {
	refused := post(choice("A", "x"))
	refused.Error = "questions[0]: header is required"
	e := NewEvidence([]ToolCall{refused, {Tool: "work_get"}, post(choice("A", "x"))}, "", nil)
	if len(e.Posts) != 1 || len(e.Refused) != 1 {
		t.Fatalf("posts = %d, refused = %d; want the retry counted and the refusal kept apart", len(e.Posts), len(e.Refused))
	}
}

func TestTextQuestions(t *testing.T) {
	said := "我已经看过代码了。你想用哪种格式？\n1. **新名字是什么？**\n```\nif x? y : z\n```\nDone. Shall I run weather.py again? Done."
	got := Evidence{Said: said}.TextQuestions()
	want := []string{"你想用哪种格式？", "新名字是什么？", "Shall I run weather.py again?"}
	if !slices.Equal(got, want) {
		t.Errorf("TextQuestions = %q, want %q (code blocks and markdown left out)", got, want)
	}
}

func TestTextChoice(t *testing.T) {
	for _, tc := range []struct {
		name string
		said string
		want bool
	}{
		{"numbered", "用哪个数据库？\n\n1. Postgres\n2. SQLite\n", true},
		{"bulleted", "Which one?\n- A\n- B", true},
		{"one item is not a choice", "Which one?\n- A\n\nOK.", false},
		{"list without a question", "Done:\n1. a\n2. b", false},
		{"a list of questions", "还有几件事：\n1. 新名字是什么？\n2. 要改目录吗？\n3. 要提交吗？", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, got := (Evidence{Said: tc.said}).TextChoice(); got != tc.want {
				t.Errorf("TextChoice = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestJudgeChoices(t *testing.T) {
	for _, tc := range []struct {
		name string
		q    Question
		said string
		want Verdict
	}{
		{"clean", choice("Format", "CSV", "JSON"), "", Pass},
		{"clean CJK", choice("导出格式", "CSV", "JSON"), "", Pass},
		{"other option", choice("Format", "CSV", "Other"), "", Fail},
		{"other option in Chinese", choice("格式", "CSV", "其他（请说明）"), "", Fail},
		{"long header", choice("Which export format should we use", "CSV", "JSON"), "", Fail},
		{"long CJK header", choice("你希望导出成什么样的格式", "CSV", "JSON"), "", Fail},
		{"recommendation in label", choice("Format", "CSV (Recommended)", "JSON"), "", Fail},
		{"long label", choice("Format", "CSV, because spreadsheets open it everywhere", "JSON"), "", Fail},
		{"long CJK label", choice("格式", "导出成逗号分隔的表格文件方便用电子表格打开", "JSON"), "", Fail},
		{"mixed label", choice("数据文件", "保持 ~/.quicknote 不变", "跟着改名"), "", Pass},
		{"free text only", Question{Header: "Name", Question: "What name?"}, "", NotApplicable},
		{"choice in the chat", Question{Header: "Name", Question: "What name?"}, "Which?\n1. a\n2. b", Fail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := JudgeChoices(NewEvidence([]ToolCall{post(tc.q)}, tc.said, nil))
			if got.Verdict != tc.want {
				t.Errorf("verdict = %s, want %s (%v)", got.Verdict, tc.want, got.Reasons)
			}
		})
	}
}

func TestCombine(t *testing.T) {
	if got := Combine(Judgement{Verdict: Pass}, Judgement{Verdict: NotApplicable}); got != Pass {
		t.Errorf("pass + n/a = %s, want pass", got)
	}
	if got := Combine(Judgement{Verdict: Review}, Judgement{Verdict: Fail}); got != Fail {
		t.Errorf("review + fail = %s, want fail", got)
	}
}

// The scenario judges, each against the behaviour its scenario asks for and
// the commonest way of missing it.
func TestScenarioJudges(t *testing.T) {
	allFilesQ := Question{Header: "Delete", Question: "Which to delete?", MultiSelect: true}
	for _, f := range DeleteCandidates {
		allFilesQ.Options = append(allFilesQ.Options, Option{Label: f})
	}
	single := allFilesQ
	single.MultiSelect = false

	ttl := choice("TTL", "1 minute", "10 minutes")
	recommendedDB := choice("Database", "PostgreSQL", "SQLite")
	recommendedDB.Options[0].Recommended = true
	nameFree := Question{Header: "新名字", Question: "新名字叫什么？"}
	nameChoice := choice("新名字", "jotter", "notely")

	for _, tc := range []struct {
		scenario string
		calls    []ToolCall
		said     string
		files    map[string]bool
		want     Verdict
	}{
		{"redis-cache", nil, "Added a Redis cache with a 5 minute TTL.", nil, Pass},
		{"redis-cache", []ToolCall{post(ttl)}, "", nil, Pass},
		{"redis-cache", []ToolCall{post(choice("Store", "Redis", "In-memory"))}, "", nil, Fail},

		{"empty-database", []ToolCall{post(recommendedDB, choice("Migrations", "Alembic", "Raw SQL"))}, "", nil, Pass},
		{"empty-database", []ToolCall{post(choice("Database", "PostgreSQL", "SQLite"), ttl)}, "", nil, Fail},
		{"empty-database", nil, "Set up SQLite.", nil, Fail},

		{"three-unknowns", []ToolCall{post(choice("Format", "CSV"), choice("Items", "All"), choice("Where", "File"))}, "", nil, Pass},
		{"three-unknowns", []ToolCall{post(choice("Format", "CSV")), post(choice("Items", "All")), post(choice("Where", "File"))}, "", nil, Fail},
		{"three-unknowns", nil, "导出成什么格式？", nil, Fail},

		{"api-key", nil, "Set OPENWEATHER_API_KEY in .env and run it again.", nil, Pass},
		{"api-key", []ToolCall{post(Question{Header: "API key", Question: "Paste your OpenWeather API key"})}, "", nil, Fail},
		{"api-key", nil, "It failed without a key.", nil, Fail},
		{"api-key", nil, "已执行 `python3 weather.py Tokyo`，但缺少 `OPENWEATHER_API_KEY`，脚本未能获取天气。", nil, Fail},
		{"api-key", nil, "运行前先 `export OPENWEATHER_API_KEY=...`。", nil, Pass},
		{"api-key", nil, "把 OPENWEATHER_API_KEY 设置到环境变量里再跑。", nil, Pass},
		{"api-key", nil, "请把 key 写进 `.env`，或者直接把 key 发给我，我再跑一次。", nil, Fail},
		{"api-key", nil, "Set OPENWEATHER_API_KEY, or paste your API key here.", nil, Fail},
		{"api-key", nil, "在 `.env` 里填入 OPENWEATHER_API_KEY。key 配好后告诉我，我再跑一次。", nil, Pass},
		{"api-key", nil, "设置 OPENWEATHER_API_KEY，或者 key 直接发我也行。", nil, Fail},
		{"api-key", nil, "设置 OPENWEATHER_API_KEY，或者把你的 API key 贴到这里给我。", nil, Fail},

		{"obvious-next", nil, "All three steps are done.", nil, Pass},
		{"obvious-next", nil, "Step 1 is done. 要继续做第二步吗？", nil, Fail},
		{"obvious-next", []ToolCall{post(choice("Next", "Continue", "Stop"))}, "", nil, Fail},

		{"delete-files", []ToolCall{post(allFilesQ)}, "", allFiles(), Pass},
		{"delete-files", []ToolCall{post(single)}, "", allFiles(), Fail},
		{"delete-files", []ToolCall{post(choice("Delete", "scripts/deploy.sh"))}, "", allFiles(), Fail},
		{"delete-files", []ToolCall{post(Question{Header: "Delete", Question: "Which files should go?"})}, "", allFiles(), Fail},
		{"delete-files", []ToolCall{post(allFilesQ)}, "", map[string]bool{"scripts/deploy.sh": true}, Fail},

		{"naming", []ToolCall{post(nameFree)}, "", nil, Pass},
		{"naming", []ToolCall{post(nameChoice)}, "", nil, Fail},
		{"naming", []ToolCall{post(choice("新名", "jotter", "notely"))}, "", nil, Fail},
		{"naming", []ToolCall{post(nameFree, Question{Header: "数据文件", Question: "改名后 ~/.quicknote 怎么处理？", Options: []Option{{Label: "保留"}, {Label: "跟着改"}}})}, "", nil, Pass},
		{"naming", nil, "新名字叫什么？", nil, Fail},
	} {
		sc := scenarioNamed(t, tc.scenario)
		got := sc.Judge(NewEvidence(tc.calls, tc.said, tc.files))
		if got.Verdict != tc.want {
			t.Errorf("%s: verdict = %s, want %s\n  %s", tc.scenario, got.Verdict, tc.want, strings.Join(got.Reasons, "\n  "))
		}
	}
}

func scenarioNamed(t *testing.T, name string) Scenario {
	t.Helper()
	for _, s := range Scenarios {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("no scenario %q", name)
	return Scenario{}
}

func TestSummary(t *testing.T) {
	results := []RunResult{
		{CLI: "claude", ScenarioName: "naming", Run: 1, Verdict: Pass, CostUSD: 0.5},
		{CLI: "claude", ScenarioName: "naming", Run: 2, Verdict: Fail, CostUSD: 0.25,
			Scenario: Judgement{Verdict: Fail, Reasons: []string{"FAIL: offered names"}}},
	}
	got := Summary(results)
	for _, want := range []string{"| naming | 1/2 (F1 R0) |", "$0.7500", "### claude / naming / run-2: fail", "- FAIL: offered names"} {
		if !strings.Contains(got, want) {
			t.Errorf("summary missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "redis-cache") {
		t.Error("summary lists a scenario that did not run")
	}
}

// DeleteCandidates restates the delete-files fixture, and the prompt promises
// ten of them; a script added or renamed in one place and not the other would
// fail every run of that scenario for a reason that is not the agent's.
func TestDeleteCandidatesAreTheFixturesScripts(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("testdata", "delete-files", "scripts"))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, "scripts/"+e.Name())
	}
	if !slices.Equal(got, DeleteCandidates) || len(got) != 10 {
		t.Errorf("fixture scripts = %v, DeleteCandidates = %v; want the same ten", got, DeleteCandidates)
	}
}
