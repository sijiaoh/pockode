// The question batches the fake CLI asks. A chat message that is exactly a
// scenario's `prompt` makes it ask that scenario's questions; a work's kickoff
// asks `work`. shoot.mjs reads the same objects to know which header belongs
// to which shape, so a question renamed here is renamed for both.

export const Q = {
	database: {
		header: "Database",
		question:
			"Which database should the job queue use? It needs to survive a restart of the worker, and we expect a few thousand jobs a day.",
		options: [
			{
				label: "Postgres",
				description: "Managed, and we already run one for the app.",
				recommended: true,
			},
			{ label: "SQLite", description: "One file next to the worker, no ops." },
			{
				label: "Redis",
				description: "Fast, but another service to run and back up.",
			},
		],
	},
	runtimes: {
		header: "Runtimes",
		question: "Which runtimes should the CI matrix cover?",
		multi_select: true,
		options: [
			{ label: "Node 22", description: "The current LTS." },
			{
				label: "Node 24",
				description: "What production runs today.",
				recommended: true,
			},
			{ label: "Bun", description: "Only the scripts use it." },
			{ label: "Deno" },
		],
	},
	releaseNote: {
		header: "Release note",
		question:
			"What should the release note say about the `jobs` table migration? Users who run their own database will have to run it by hand.",
	},
	migration: {
		header:
			"Migration strategy for the legacy billing tables and every foreign key that still points at them",
		question:
			"The legacy `billing_invoices` table is referenced from `src/billing/legacy/adapters/stripe_webhook_reconciliation_handler.ts` and three other places.\n\nHow should the rows be moved?\n\n```sql\nALTER TABLE billing_invoices RENAME TO billing_invoices_legacy;\n```",
		options: [
			{
				label:
					"Copy every row into the new schema in one transaction during the maintenance window, then drop the old tables",
				description:
					"Simplest to reason about, but the window has to be long enough for the largest customer's history.",
			},
			{
				label:
					"Dual-write to both schemas for a release, backfill in batches, then switch reads over",
				description: "No downtime, two releases of extra code.",
			},
			{
				label: "billing_invoices_legacy_reconciliation_backfill_v2_final",
				description: "The script from the last attempt, re-run as is.",
			},
		],
	},
	region: {
		header: "Region",
		question:
			"Which region should the **staging** cluster live in? Production is in `eu-west-1`.",
		options: [
			{ label: "eu-west-1", description: "Same as production." },
			{ label: "us-east-1", description: "Closer to the US team." },
		],
	},
	workScope: {
		header: "Scope",
		question: "Should this task also update the API docs, or only the code?",
		options: [
			{ label: "Code and docs", recommended: true },
			{ label: "Code only" },
		],
	},
	workNotes: {
		header: "Reviewer",
		question: "Who should review the change when it is ready?",
	},
};

export const SCENARIOS = {
	batch: {
		prompt: "Set up the job queue for the worker.",
		lead: "Before I touch the queue I need a few decisions from you.",
		questions: [Q.database, Q.runtimes, Q.releaseNote, Q.migration, Q.region],
	},
	single: {
		prompt: "Pick a database for the job queue.",
		lead: "One thing before I go on.",
		questions: [Q.database],
	},
	work: {
		lead: "Two decisions before I start on this task.",
		questions: [Q.workScope, Q.workNotes],
	},
};
