from __future__ import annotations

import hashlib
from dataclasses import dataclass, field


@dataclass
class Job:
    title: str
    company: str
    city: str
    salary: str
    jd: str
    url: str = ""
    source: str = "manual"
    job_id: str = ""

    def __post_init__(self) -> None:
        if not self.job_id:
            key = f"{self.source}|{self.company}|{self.title}|{self.city}".lower()
            self.job_id = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


@dataclass
class ScoredJob:
    job: Job
    score: int
    priority: str
    reason: str
    concerns: list[str] = field(default_factory=list)
    resume_version: str = ""
    pitch: str = ""
