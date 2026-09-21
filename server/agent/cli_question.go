package agent

// Every CLI Pockode drives ships an ask-the-user tool of its own — Claude's
// AskUserQuestion, Codex's requestUserInput — and neither of them reaches a
// Pockode user. Both hold the turn open waiting on an answer that has nowhere to
// come from, which is the shape question_post exists to replace: it records the
// question, returns at once, and the answer arrives as a message whenever it
// arrives.
//
// The first line of defence is to keep the tool out of the model's hands
// (claude.buildArgs disables it outright; Codex offers no equivalent switch).
// This is the second: what the model is told at the point it expected an answer.

// CLIQuestionRefusal is that text, and there is one copy of it because there is
// one fact to state. It says the same three things as the question_post tool
// result and the work_needs_input retirement notice — posted and it returns,
// nothing waits on you, the answer comes back as a message — so that an agent
// meeting all three does not have to work out whether they describe one
// mechanism or three.
const CLIQuestionRefusal = "This question was not delivered to the user: Pockode does not ask the user through this tool. " +
	"Ask with question_post instead. It returns as soon as the question is posted — nothing waits on you, so carry on " +
	"working or end your turn — and the answer, or the user's refusal to answer, arrives as a message in this chat, " +
	"possibly after this turn has ended."

// CLIQuestionRefusedCode marks the warning below in the transcript.
const CLIQuestionRefusedCode = "cli_question_refused"

// CLIQuestionRefusedWarning is the record the user gets for it, and the reason
// this refusal is not silent: something visible happened in their session — the
// agent asked them something they will never see — and without this the only
// trace is a tool row that failed (Claude) or nothing at all (Codex). cli names
// the CLI as the user knows it, since the tool is the CLI's and not Pockode's.
func CLIQuestionRefusedWarning(cli string) WarningEvent {
	return WarningEvent{
		Message: cli + " tried to ask you a question through its own tool, which does not reach you. " +
			"It was told to use Pockode's question_post instead.",
		Code: CLIQuestionRefusedCode,
	}
}
