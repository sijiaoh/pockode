import argparse
from pathlib import Path

NOTES = Path.home() / ".quicknote"


def main() -> None:
    parser = argparse.ArgumentParser(prog="quicknote")
    parser.add_argument("text", nargs="?")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    if args.list:
        print(NOTES.read_text() if NOTES.exists() else "")
    elif args.text:
        with NOTES.open("a") as f:
            f.write(args.text + "\n")
