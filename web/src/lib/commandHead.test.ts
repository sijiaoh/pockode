import { describe, expect, it } from "vitest";
import { commandHead, unwrapShellCommand } from "./commandHead";

// Commands below are taken (shortened) from real agent sessions.
describe("commandHead", () => {
	it.each([
		["pnpm run test", "pnpm run test"],
		["go test ./relay/... -run TestX", "go test ./relay/..."],
		['git commit -m "Fix it"', "git commit"],
		["python3 -I x.py", "python3"],
		["docker compose up web db", "docker compose up"],
		["pnpm test 2>&1 | tail -15", "pnpm test"],
		["cat x | rg foo", "cat x"],
		["ls; pwd", "ls"],
		["pnpm dev & sleep 2", "pnpm dev"],
	])("names %j by its first words", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	// `find  .` read as a stray gap: a bare `.` names where, not what.
	it("stops at a bare scope", () => {
		expect(
			commandHead('find . -name "*.md" -not -path "*/node_modules/*" | head'),
		).toBe("find");
		expect(commandHead("ls ..")).toBe("ls");
	});

	it("stops at an argument the shell expands", () => {
		expect(commandHead("cp /tmp/out/{hero,archer}.png $D/")).toBe("cp");
		expect(commandHead("ls packages/*/src")).toBe("ls");
		expect(commandHead('grep -n "$q" docs')).toBe("grep");
	});

	it.each([
		["cd web && CI=1 pnpm test -- --run", "pnpm test"],
		["cd a && cd b && make", "make"],
		["cd web; pnpm test", "pnpm test"],
		["cd web\npnpm test", "pnpm test"],
		['cd "my dir" && make build', "make build"],
		["cd .. && git status --short", "git status"],
		[
			"cd server; export PATH=/tmp/go/bin:$PATH; go test -race ./...",
			"go test",
		],
		["source .venv/bin/activate && pytest -x", "pytest"],
		["set -euo pipefail\nnpm ci", "npm ci"],
	])("passes over where %j runs", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	it.each([
		['FOO="a b" BAR= node x.js', "node x.js"],
		[
			'B=$(readlink -f "$(which claude)"); echo $B; ls -la "$B" | head -2',
			"ls",
		],
		["P=/tmp/x; cd $P && git log --oneline", "git log"],
		['UA="Mozilla/5.0 (Macintosh; Intel)"; curl -s -A "$UA" -L x', "curl"],
		["arr=(a b c); wc -l $arr", "wc"],
	])("passes over the variables %j sets", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	it.each([
		[
			'for q in "マスターデータ" "master data"; do echo "== $q"; gh search issues --repo o/r "$q" --limit 100; done',
			"gh search issues",
		],
		["for i in $(seq 1 40); do mkdir -p d$i; done", "mkdir"],
		["for ((i = 0; i < 3; i++)); do curl -s localhost; done", "curl"],
		["while read -r f; do wc -l $f; done < list", "wc"],
		["until grep -q ready log; do sleep 1; done", "grep"],
		["if [ -f go.mod ]; then go build ./...; fi", "go build"],
		["if [[ -d node_modules && -f x ]]; then pnpm build; fi", "pnpm build"],
		["[[ -f x ]] || touch x", "touch x"],
		["test -d dist && rm -rf dist", "rm"],
	])("reads through the loop or conditional in %j", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	it.each([
		[
			"(pnpm typecheck && echo OK; pnpm lint) > /tmp/out 2>&1",
			"pnpm typecheck",
		],
		["{ make; make test; } 2>&1 | tee log", "make"],
		["! git diff --quiet", "git diff"],
		["(cd web && pnpm build)", "pnpm build"],
	])("reads into the subshell or group %j", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	it.each([
		[
			"TAG=before timeout 300 pnpm exec playwright test zz",
			"pnpm exec playwright",
		],
		["sudo -E npm i -g pnpm", "npm i"],
		["env -i HOME=$HOME node -v", "node"],
		["nohup ./pockode --port 9000 > log 2>&1 &", "pockode"],
		["time go test ./...", "go test"],
		["/tmp/gotoolchain/go/bin/go vet ./...", "go vet"],
		["sudo -u deploy make install", "make install"],
		["timeout -s KILL 5 curl -s localhost", "curl"],
		// A lookup of a command is not a run of it.
		["command -v node", "command"],
		["env | grep PATH", "env"],
	])("names what %j wraps", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	// Codex hands over every command wrapped in the shell that runs it.
	it.each([
		["/bin/bash -lc 'rg -n foo src'", "rg"],
		['/bin/zsh -lc "cd web && pnpm test"', "pnpm test"],
		["zsh -l -c 'whence -a node'", "whence"],
		["bash scripts/release.sh v1", "bash scripts/release.sh v1"],
	])("unwraps the shell around %j", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	it.each([
		["cat <<EOF\nhi\nEOF", "cat"],
		[
			"python3 -I - <<'EOF'\nfor x in y:\n    print(x)\nEOF\npnpm test",
			"python3",
		],
		["echo ok <<EOF\nfor x in a; do\nEOF\nmake", "make"],
		["# build it\npnpm build", "pnpm build"],
		["pnpm test \\\n  --run", "pnpm test"],
		["git  status\t--short", "git status"],
		["find . -exec rm {} \\;; ls", "find"],
		["echo x > out.txt; make", "make"],
		["cat <<\\EOF\nfor x in a; do\nEOF", "cat"],
		["echo a <<\\EOF\nfor x in a; do\nEOF\nmake", "make"],
		["echo <(sort a) && diff a b", "diff a b"],
		["cd web\r\npnpm test\r\n", "pnpm test"],
	])("reads the shell's own syntax in %j", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	it.each([
		["cd web", "cd web"],
		["sleep 30", "sleep 30"],
		["echo done", "echo done"],
	])("names %j by its setup when that is all it does", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	it.each([
		"-x",
		"$FF -v error -i in.mp4 out.png",
		'C="docker compose"; $C build server',
		'"$CH" --headless=new --screenshot',
		'for f in $(git diff --name-only); do echo "$f $(grep -c x $f)"; done',
		"case $1 in a) make;; esac",
		"cd ~/work; for d in */; do r=$(git -C $d remote); echo $r; done",
		"while true; do sleep 1; done",
		"if [ -f x ]; then echo yes; fi",
	])("says nothing rather than guess at %j", (command) => {
		expect(commandHead(command)).toBeUndefined();
	});
});

describe("unwrapShellCommand", () => {
	it.each([
		["/bin/zsh -lc 'sleep 45; echo main-done'", "sleep 45; echo main-done"],
		["bash -c 'ls -la'", "ls -la"],
		["/usr/bin/sh -lc 'cat a\nb'", "cat a\nb"],
		[`/bin/zsh -lc 'echo '"'"'hi'"'"''`, "echo 'hi'"],
		[`bash -lc "pnpm test"`, "pnpm test"],
	])("takes the script out of %j", (command, script) => {
		expect(unwrapShellCommand(command)).toBe(script);
	});

	it.each([
		["anything after the script", "bash -lc 'make' && echo done"],
		["a redirection after it", "bash -lc 'make' > out.log"],
		["a redirection before it", "2>/dev/null bash -lc 'make'"],
		["a comment after it", "bash -lc 'make' # build"],
		["a second argument", "bash -c 'echo $0' arg"],
		["an unclosed quote", "bash -lc 'make"],
		["an expansion inside double quotes", `bash -lc "echo $HOME"`],
		["an escape inside double quotes", `bash -lc "echo \\"x\\""`],
		["an empty script", "bash -lc ''"],
		["an unquoted glob as the script", "zsh -lc *.sh"],
		["an unquoted home as the script", "zsh -lc ~/x.sh"],
		["a shell that is not one", "fish -c 'ls'"],
		["no envelope", "sleep 45; echo main-done"],
	])("keeps the command as it is with %s", (_, command) => {
		expect(unwrapShellCommand(command)).toBe(command);
	});
});
