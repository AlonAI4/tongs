#!/usr/bin/env python3
"""Chat-size detector for the Tongs skill. Read-only, except config.json for --limit.

  --report      how many tokens this chat's last message re-read, and how much of that is setup
  --limit N     change the limit (500000, 500,000, 500k or 0.5m); the Tongs meter reads it too
"""
import glob, json, os, re, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(HERE, "config.json")
DEFAULT_LIMIT = 400000
PROJECTS = os.path.expanduser("~/.claude/projects")


def load_config():
    try:
        with open(CONFIG) as f:
            config = json.load(f)
        return config if isinstance(config, dict) else {}
    except (OSError, ValueError):
        return {}


def sizes(u):
    return (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
            + u.get("cache_creation_input_tokens", 0))


def usages(lines):
    for line in lines:
        if '"usage"' not in line or '"isSidechain":true' in line:  # skip subagents' replies
            continue
        try:
            yield sizes(json.loads(line)["message"]["usage"])
        except (ValueError, KeyError, TypeError, AttributeError):
            continue


def last_size(transcript):
    """Tokens the newest reply re-read. Reads only the end of the file, so it stays fast on huge chats."""
    try:
        with open(transcript, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4_000_000))
            tail = f.read().decode(errors="ignore").splitlines()
    except OSError:
        return 0
    found = list(usages(tail))
    return found[-1] if found else 0


def first_size(transcript):
    """Tokens the first reply read: the setup cost before any chat."""
    try:
        with open(transcript, errors="ignore") as f:
            return next(usages(f), 0)
    except OSError:
        return 0


def find_transcript():
    """(path, how it was found). Claude Code gives each chat's commands its session id, which names
    the chat's file exactly; without it, use the newest chat of this folder, then the newest anywhere."""
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if re.fullmatch(r"[\w-]+", sid):
        exact = glob.glob(os.path.join(PROJECTS, "*", sid + ".jsonl"))
        if exact:
            return exact[0], "this chat"
    folder = os.path.join(PROJECTS, "".join(c if c.isalnum() else "-" for c in os.getcwd()))
    for files, how in ((glob.glob(folder + "/*.jsonl"), "newest chat in this folder"),
                       (glob.glob(PROJECTS + "/*/*.jsonl"), "newest chat anywhere: a guess")):
        if files:
            return max(files, key=os.path.getmtime), how
    return None, "no chat found"


def parse_tokens(text):
    """500000, 500,000, 500k, 0.5m -> 500000. None if it isn't a sensible limit."""
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([km]?)", text.strip().lower().replace(",", "").replace("_", ""))
    if not m:
        return None
    n = round(float(m.group(1)) * {"": 1, "k": 1000, "m": 1000000}[m.group(2)])
    return n if 10000 <= n <= 1000000 else None


def main():
    config = load_config()
    limit = config.get("limit") if isinstance(config.get("limit"), int) and config["limit"] > 0 else DEFAULT_LIMIT
    args = sys.argv[1:]

    if args[:1] == ["--limit"]:
        new = parse_tokens(args[1]) if len(args) > 1 else None
        if new is None:
            print("Give a limit between 10k and 1m tokens per message, for example: --limit 500k")
            return 2
        with open(CONFIG, "w") as f:
            json.dump({**config, "limit": new}, f)
        print(f"Limit changed: {limit:,} -> {new:,} tokens per message.")
        return 0

    if args[:1] == ["--report"]:
        path, how = find_transcript()
        if not path:
            print("No chat found yet: the size shows after Claude's first reply.")
            return 0
        size, base = last_size(path), first_size(path)
        print(f"Last message re-read about {size:,} tokens (limit {limit:,}). "
              + ("Over the limit: map it with /tongs, then compact." if size > limit else "Under the limit.")
              + ("" if how == "this chat" else f" ({how})"))
        print(f"Setup (first message): about {base:,}. This chat added: about {max(0, size - base):,}.")
        return 0

    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main())
