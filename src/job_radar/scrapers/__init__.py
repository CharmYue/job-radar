"""ATS scrapers (public APIs).

Each module exposes `async def fetch(slug, keywords=None) -> list[Job]`.
Wired up here for convenience.
"""
from . import greenhouse, lever, smartrecruiters, workday  # noqa: F401

__all__ = ["greenhouse", "lever", "smartrecruiters", "workday"]
