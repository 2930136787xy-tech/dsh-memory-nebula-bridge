# -*- coding: utf-8 -*-
"""DSH ←→ 记忆库 的桥命令：让 DSH 会话能「想起来」「记住」「有心情」。

由 DSH 插件调用，也可以自己手跑：

    python tools/dsh_bridge.py --store D:\\my-memory stats
    python tools/dsh_bridge.py --store D:\\my-memory recall --query 猫 --limit 5
    python tools/dsh_bridge.py --store D:\\my-memory remember --text "用户喜欢深夜写代码" --importance 0.8
    python tools/dsh_bridge.py --store D:\\my-memory mood
    python tools/dsh_bridge.py --store D:\\my-memory mood --set 0.6,0.3,0.7

所有命令都把结果打到 stdout（JSON），失败时 exit 非 0 并在 stderr 说明原因。
只依赖标准库，不引入任何第三方包。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
import time

HALF_LIFE_DAYS = 90.0          # 与 settings.json 里的 forget.half_life_days 保持一致
RECALL_WEIGHTS = {"importance": 0.45, "recency": 0.30, "pinned": 0.15, "match": 0.35}


def now_ms() -> int:
    return int(time.time() * 1000)


def open_ro(path: str) -> sqlite3.Connection | None:
    if not os.path.exists(path):
        return None
    try:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except Exception:
        return None


def open_rw(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path, timeout=10)
    con.execute("PRAGMA journal_mode=WAL")
    return con


def shared_db(store: str) -> str:
    return os.path.join(store, "bridge.db")


def brain_db(store: str) -> str:
    return os.environ.get("VIEW_DB") or os.path.join(store, "brain.db")


def _cols(con: sqlite3.Connection, table: str) -> list[str]:
    try:
        return [r[1] for r in con.execute(f"pragma table_info({table})")]
    except Exception:
        return []


def collect(store: str) -> list[dict]:
    """把两份库里的记忆拍平成同一个形状。"""
    out: list[dict] = []
    for tag, path in (("s", shared_db(store)), ("b", brain_db(store))):
        con = open_ro(path)
        if not con:
            continue
        try:
            cols = _cols(con, "memories")
            if not cols:
                continue
            want = ["id", "content", "importance", "status", "pinned", "created_at"]
            if "conversation_key" in cols:
                want.append("conversation_key")
            if "speaker_id" in cols:
                want.append("speaker_id")
            if "confidence" in cols:
                want.append("confidence")
            sql = "select " + ", ".join(want) + " from memories"
            for row in con.execute(sql):
                rec = dict(zip(want, row))
                rec["store"] = tag
                rec["id"] = f"mem:{tag}:{rec['id']}"
                out.append(rec)
        except Exception:
            continue
        finally:
            con.close()
    return out


def recency(created_at) -> float:
    try:
        ts = float(created_at or 0)
    except Exception:
        return 0.0
    if ts <= 0:
        return 0.0
    if ts > 1e11:      # 毫秒
        ts = ts / 1000.0
    age_days = max(0.0, (time.time() - ts) / 86400.0)
    return math.pow(0.5, age_days / HALF_LIFE_DAYS)


def cmd_stats(args) -> dict:
    counts = {}
    for tag, path in (("shared", shared_db(args.store)), ("local", brain_db(args.store))):
        con = open_ro(path)
        if not con:
            counts[tag] = 0
            continue
        try:
            counts[tag] = int(con.execute("select count(*) from memories").fetchone()[0])
        except Exception:
            counts[tag] = 0
        finally:
            con.close()
    mood = read_mood(args.store)
    return {"store": args.store, "counts": counts, "mood": mood}


def read_mood(store: str, speaker: str = "") -> dict:
    con = open_ro(brain_db(store))
    if not con:
        return {}
    try:
        if _cols(con, "emotion_state"):
            rows = list(con.execute(
                "select speaker_id, valence, arousal, affection from emotion_state"))
            if speaker:
                rows = [r for r in rows if str(r[0]) == speaker]
            return {str(r[0]): {"valence": r[1], "arousal": r[2], "affection": r[3]} for r in rows}
        return {}
    except Exception:
        return {}
    finally:
        con.close()


def cmd_mood(args) -> dict:
    if not args.set:
        return {"mood": read_mood(args.store, args.speaker or "")}
    parts = [p.strip() for p in args.set.split(",")]
    if len(parts) != 3:
        raise SystemExit("--set 需要三个值：valence,arousal,affection，例如 --set 0.6,0.3,0.7")
    valence, arousal, affection = (float(x) for x in parts)
    kind = args.speaker or (args.persona or "dsh")
    path = brain_db(args.store)
    con = open_rw(path)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS emotion_state ("
                    "speaker_id TEXT, valence REAL, arousal REAL, affection REAL)")
        con.execute("DELETE FROM emotion_state WHERE speaker_id = ?", (kind,))
        con.execute("INSERT INTO emotion_state (speaker_id, valence, arousal, affection)"
                    " VALUES (?,?,?,?)", (kind, valence, arousal, affection))
        con.commit()
    finally:
        con.close()
    return {"saved": {kind: {"valence": valence, "arousal": arousal, "affection": affection}}}


def cmd_recall(args) -> dict:
    items = collect(args.store)
    needle = (args.query or "").strip().lower()
    alive = []
    for rec in items:
        status = str(rec.get("status") or "active")
        if status == "deleted":
            continue
        if status == "faded" and not args.include_faded:
            continue
        text = str(rec.get("content") or "")
        hit = 0.0
        if needle:
            low = text.lower()
            if needle in low:
                hit = 1.0
                if low.startswith(needle):
                    hit = 1.2
            else:
                # 按字命中率给个软分，避免完全搜不到
                hits = sum(1 for ch in set(needle) if ch in low)
                hit = 0.3 * hits / max(1, len(set(needle)))
        score = (
            RECALL_WEIGHTS["importance"] * float(rec.get("importance") or 0)
            + RECALL_WEIGHTS["recency"] * recency(rec.get("created_at"))
            + RECALL_WEIGHTS["pinned"] * (1.0 if rec.get("pinned") else 0.0)
            + RECALL_WEIGHTS["match"] * hit
        )
        if needle and hit <= 0:
            continue
        rec["score"] = round(score, 4)
        rec["text"] = text
        alive.append(rec)

    alive.sort(key=lambda r: r["score"], reverse=True)
    picked = alive[: max(1, int(args.limit or 8))]
    return {"total": len(items), "matched": len(alive), "items": picked}


def cmd_remember(args) -> dict:
    text = " ".join(str(args.text or "").split())
    if not text:
        raise SystemExit("--text 不能为空")
    now = now_ms()
    if args.store_kind == "b":
        path = brain_db(args.store)
        con = open_rw(path)
        try:
            con.execute("""CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY, speaker_id TEXT, kind TEXT, content TEXT,
                importance REAL, confidence REAL, strength REAL, created_at INTEGER,
                updated_at INTEGER, status TEXT, source TEXT, superseded_by INTEGER,
                access_count INTEGER, pinned INTEGER)""")
            cur = con.execute(
                "INSERT INTO memories (speaker_id, kind, content, importance, confidence, strength,"
                " created_at, updated_at, status, source, superseded_by, access_count, pinned)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (args.speaker or "", args.kind or "fact", text, float(args.importance),
                 0.8, 1.0, now, now, "active", "dsh", None, 0, 1 if args.pinned else 0))
            con.commit()
            new_id = cur.lastrowid
        finally:
            con.close()
        return {"store": "b", "id": f"mem:b:{new_id}", "text": text}

    path = shared_db(args.store)
    con = open_rw(path)
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY, content TEXT, conversation_key TEXT,
            created_at INTEGER, updated_at INTEGER, subject TEXT, status TEXT,
            confidence REAL, importance REAL, superseded_by INTEGER, pinned INTEGER)""")
        dup = con.execute("select id from memories where content = ? limit 1", (text,)).fetchone()
        if dup and not args.allow_duplicates:
            return {"store": "s", "id": f"mem:s:{dup[0]}", "text": text, "duplicate": True}
        cur = con.execute(
            "INSERT INTO memories (content, conversation_key, created_at, updated_at, subject,"
            " status, confidence, importance, superseded_by, pinned)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (text, args.conversation or "dsh:main", now, now, args.speaker or "",
             "active", 0.8, float(args.importance), None, 1 if args.pinned else 0))
        con.commit()
        new_id = cur.lastrowid
    finally:
        con.close()
    return {"store": "s", "id": f"mem:s:{new_id}", "text": text}


def main() -> None:
    ap = argparse.ArgumentParser(description="DSH 与记忆库之间的桥")
    ap.add_argument("--store", required=True, help="记忆库目录")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_stats = sub.add_parser("stats")
    p_stats.set_defaults(func=cmd_stats)

    p_recall = sub.add_parser("recall")
    p_recall.add_argument("--query", default="")
    p_recall.add_argument("--limit", type=int, default=8)
    p_recall.add_argument("--include-faded", action="store_true")
    p_recall.set_defaults(func=cmd_recall)

    p_remember = sub.add_parser("remember")
    p_remember.add_argument("--text", required=True)
    p_remember.add_argument("--importance", type=float, default=0.6)
    p_remember.add_argument("--speaker", default="")
    p_remember.add_argument("--conversation", default="dsh:main")
    p_remember.add_argument("--kind", default="fact")
    p_remember.add_argument("--store-kind", choices=["s", "b"], default="s")
    p_remember.add_argument("--pinned", action="store_true")
    p_remember.add_argument("--allow-duplicates", action="store_true")
    p_remember.set_defaults(func=cmd_remember)

    p_mood = sub.add_parser("mood")
    p_mood.add_argument("--set", default="", help="valence,arousal,affection")
    p_mood.add_argument("--speaker", default="")
    p_mood.add_argument("--persona", default="")
    p_mood.set_defaults(func=cmd_mood)

    args = ap.parse_args()
    args.store = os.path.abspath(os.path.expanduser(args.store))
    try:
        result = args.func(args)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()