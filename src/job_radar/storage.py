from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterator

from .models import ScoredJob

DB_PATH = Path(__file__).resolve().parents[2] / "data" / "jobs.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id     TEXT PRIMARY KEY,
    title      TEXT,
    company    TEXT,
    city       TEXT,
    salary     TEXT,
    url        TEXT,
    source     TEXT,
    score      INTEGER,
    priority   TEXT,
    reason     TEXT,
    first_seen TEXT,
    last_seen  TEXT,
    status     TEXT DEFAULT 'new'
);

CREATE TABLE IF NOT EXISTS daily_reports (
    date      TEXT PRIMARY KEY,
    total     INTEGER,
    s_count   INTEGER,
    a_count   INTEGER,
    report_md TEXT,
    pushed    INTEGER DEFAULT 0
);
"""


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _conn() as c:
        c.executescript(_SCHEMA)


@contextmanager
def _conn() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def is_duplicate(job_id: str, within_days: int = 30) -> bool:
    cutoff = (datetime.now() - timedelta(days=within_days)).date().isoformat()
    with _conn() as c:
        row = c.execute(
            "SELECT last_seen FROM jobs WHERE job_id = ? AND last_seen >= ?",
            (job_id, cutoff),
        ).fetchone()
    return row is not None


def save_job(s: ScoredJob) -> None:
    today = date.today().isoformat()
    with _conn() as c:
        existing = c.execute(
            "SELECT first_seen FROM jobs WHERE job_id = ?", (s.job.job_id,)
        ).fetchone()
        first_seen = existing[0] if existing else today
        c.execute(
            """INSERT INTO jobs(job_id,title,company,city,salary,url,source,
                                score,priority,reason,first_seen,last_seen,status)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'new')
               ON CONFLICT(job_id) DO UPDATE SET
                 score=excluded.score, priority=excluded.priority,
                 reason=excluded.reason, last_seen=excluded.last_seen""",
            (
                s.job.job_id, s.job.title, s.job.company, s.job.city, s.job.salary,
                s.job.url, s.job.source, s.score, s.priority, s.reason,
                first_seen, today,
            ),
        )


def save_report(d: str, report_md: str, total: int, s_count: int, a_count: int) -> None:
    with _conn() as c:
        c.execute(
            """INSERT INTO daily_reports(date,total,s_count,a_count,report_md,pushed)
               VALUES(?,?,?,?,?,0)
               ON CONFLICT(date) DO UPDATE SET
                 total=excluded.total, s_count=excluded.s_count,
                 a_count=excluded.a_count, report_md=excluded.report_md""",
            (d, total, s_count, a_count, report_md),
        )


def mark_pushed(d: str) -> None:
    with _conn() as c:
        c.execute("UPDATE daily_reports SET pushed = 1 WHERE date = ?", (d,))
