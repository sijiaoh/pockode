import json
import sys
from datetime import date
from pathlib import Path

STORE = Path(__file__).with_name("todos.json")


def load() -> list[dict]:
    if not STORE.exists():
        return []
    return json.loads(STORE.read_text())


def save(items: list[dict]) -> None:
    STORE.write_text(json.dumps(items, indent=2, ensure_ascii=False))


def main(argv: list[str]) -> None:
    items = load()
    cmd = argv[0] if argv else "list"
    if cmd == "add":
        items.append({"title": " ".join(argv[1:]), "done": False, "created": date.today().isoformat()})
        save(items)
    elif cmd == "done":
        items[int(argv[1]) - 1]["done"] = True
        save(items)
    elif cmd == "list":
        for i, item in enumerate(items, 1):
            mark = "x" if item["done"] else " "
            print(f"{i}. [{mark}] {item['title']}")
    else:
        sys.exit(f"unknown command: {cmd}")


if __name__ == "__main__":
    main(sys.argv[1:])
