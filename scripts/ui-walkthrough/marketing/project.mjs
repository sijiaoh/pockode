// tidy, the small todo app the marketing suite's agents work on
// (docs/marketing-assets.md §8): what ../seed.mjs commits before the server
// starts. scenarios.mjs reads the same files, so what an agent reads is what
// is on disk and its edits apply to it.

export const FILES = {
	"README.md": `# tidy

A tiny todo app. React, Vite and TypeScript, nothing else.

\`\`\`bash
pnpm install
pnpm dev     # http://localhost:5173
pnpm test
\`\`\`
`,
	"package.json": `{
	"name": "tidy",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "vite",
		"build": "tsc -b && vite build",
		"test": "vitest run"
	},
	"dependencies": {
		"react": "^19.2.0",
		"react-dom": "^19.2.0"
	},
	"devDependencies": {
		"@vitejs/plugin-react": "^5.1.0",
		"typescript": "^5.9.3",
		"vite": "^7.2.0",
		"vitest": "^4.0.8"
	}
}
`,
	"index.html": `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>tidy</title>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="/src/main.tsx"></script>
	</body>
</html>
`,
	"src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
`,
	"src/types.ts": `export interface Todo {
	id: string;
	title: string;
	done: boolean;
	createdAt: string;
}
`,
	"src/api/todos.ts": `import type { Todo } from "../types";

const KEY = "tidy.todos";

export function listTodos(): Todo[] {
	const raw = localStorage.getItem(KEY);
	return raw ? (JSON.parse(raw) as Todo[]) : [];
}

function saveTodos(todos: Todo[]): void {
	localStorage.setItem(KEY, JSON.stringify(todos));
}

export function addTodo(title: string): Todo {
	const todo: Todo = {
		id: crypto.randomUUID(),
		title: title.trim(),
		done: false,
		createdAt: new Date().toISOString(),
	};
	saveTodos([...listTodos(), todo]);
	return todo;
}

export function toggleTodo(id: string): void {
	saveTodos(
		listTodos().map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
	);
}
`,
	"src/lib/sort.ts": `import type { Todo } from "../types";

/** Open todos first, then done ones; oldest first within each. */
export function sortTodos(todos: Todo[]): Todo[] {
	return [...todos].sort((a, b) => {
		if (a.done !== b.done) return a.done ? 1 : -1;
		return a.createdAt.localeCompare(b.createdAt);
	});
}
`,
	"src/lib/sort.test.ts": `import { describe, expect, it } from "vitest";
import type { Todo } from "../types";
import { sortTodos } from "./sort";

const todo = (title: string, extra: Partial<Todo> = {}): Todo => ({
	id: title,
	title,
	done: false,
	createdAt: "2026-05-01T09:00:00Z",
	...extra,
});

describe("sortTodos", () => {
	it("puts done todos last", () => {
		const sorted = sortTodos([todo("a", { done: true }), todo("b")]);
		expect(sorted.map((t) => t.title)).toEqual(["b", "a"]);
	});
});
`,
	"src/components/TodoForm.tsx": `import { useState } from "react";

interface Props {
	onAdd: (title: string) => void;
}

export function TodoForm({ onAdd }: Props) {
	const [title, setTitle] = useState("");

	return (
		<form
			className="todo-form"
			onSubmit={(e) => {
				e.preventDefault();
				if (!title.trim()) return;
				onAdd(title);
				setTitle("");
			}}
		>
			<input
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="Add a todo…"
			/>
		</form>
	);
}
`,
	"src/components/TodoItem.tsx": `import type { Todo } from "../types";

interface Props {
	todo: Todo;
	onToggle: (id: string) => void;
}

export function TodoItem({ todo, onToggle }: Props) {
	return (
		<li className={todo.done ? "todo done" : "todo"}>
			<input
				type="checkbox"
				checked={todo.done}
				onChange={() => onToggle(todo.id)}
			/>
			<span className="title">{todo.title}</span>
		</li>
	);
}
`,
	"src/App.tsx": `import { useState } from "react";
import { addTodo, listTodos, toggleTodo } from "./api/todos";
import { TodoForm } from "./components/TodoForm";
import { TodoItem } from "./components/TodoItem";
import { sortTodos } from "./lib/sort";

export function App() {
	const [todos, setTodos] = useState(listTodos);
	const refresh = () => setTodos(listTodos());

	return (
		<main className="app">
			<h1>tidy</h1>
			<TodoForm
				onAdd={(title) => {
					addTodo(title);
					refresh();
				}}
			/>
			<ul>
				{sortTodos(todos).map((todo) => (
					<TodoItem
						key={todo.id}
						todo={todo}
						onToggle={(id) => {
							toggleTodo(id);
							refresh();
						}}
					/>
				))}
			</ul>
		</main>
	);
}
`,
};

const pick = (...names) =>
	Object.fromEntries(names.map((name) => [name, FILES[name]]));

export default {
	name: "tidy",
	author: { name: "Pockode Demo", email: "demo@example.com" },
	commits: [
		{
			message: "Scaffold tidy with Vite and React",
			minutesAgo: 3 * 24 * 60,
			files: pick("README.md", "package.json", "index.html", "src/main.tsx"),
		},
		{
			message: "Store todos in localStorage",
			minutesAgo: 2 * 24 * 60 + 190,
			files: pick("src/types.ts", "src/api/todos.ts"),
		},
		{
			message: "List, add and complete todos",
			minutesAgo: 26 * 60,
			files: pick(
				"src/components/TodoForm.tsx",
				"src/components/TodoItem.tsx",
				"src/App.tsx",
			),
		},
		{
			message: "Sort done todos to the bottom",
			minutesAgo: 5 * 60 + 12,
			files: pick("src/lib/sort.ts", "src/lib/sort.test.ts"),
		},
	],
};
