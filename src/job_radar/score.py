from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

from openai import AsyncAzureOpenAI, AsyncOpenAI

from .models import Job, ScoredJob

log = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _load_resume_text(profile: dict[str, Any]) -> str:
    candidate = profile.get("candidate") or {}
    rel = candidate.get("resume_file")
    if not rel:
        return ""
    path = Path(rel)
    if not path.is_absolute():
        path = _PROJECT_ROOT / path
    try:
        return path.read_text(encoding="utf-8")
    except OSError as e:
        log.warning("resume_file %s unreadable: %s", path, e)
        return ""

_DEEPSEEK_KEY = os.getenv("DEEP_SEEK_API") or os.getenv("DEEPSEEK_API_KEY")
_AZURE_KEY = os.getenv("AZURE_OPENAI_API_KEY")
_AZURE_ENDPOINT = os.getenv("AZURE_OPENAI_BASE_URL") or os.getenv("AZURE_OPENAI_ENDPOINT")
_AZURE_DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT")

deepseek_client: AsyncOpenAI | None = (
    AsyncOpenAI(api_key=_DEEPSEEK_KEY, base_url="https://api.deepseek.com")
    if _DEEPSEEK_KEY
    else None
)

azure_client: AsyncAzureOpenAI | None = (
    AsyncAzureOpenAI(
        api_key=_AZURE_KEY,
        azure_endpoint=_AZURE_ENDPOINT,
        api_version="2025-04-01-preview",
    )
    if (_AZURE_KEY and _AZURE_ENDPOINT)
    else None
)

_SEM = asyncio.Semaphore(3)
_VALID_PRIORITIES = {"S", "A", "B", "C", "Reject"}


def hits_hard_reject(job: Job, profile: dict[str, Any]) -> str | None:
    blob = f"{job.title} {job.jd}".lower()
    for kw in (profile.get("candidate") or {}).get("hard_reject", []):
        if kw and kw.lower() in blob:
            return kw
    return None


def _build_messages(job: Job, profile: dict[str, Any]) -> list[dict[str, str]]:
    candidate = profile.get("candidate") or {}
    premium = float(profile.get("beijing_salary_premium", 0.10))

    system = (
        "你是资深求职顾问,为候选人筛选岗位。严格输出 JSON,不要 markdown 代码块。"
        "字段: score(0-100 整数), priority(S/A/B/C/Reject 之一), reason(一句中文), "
        "concerns(string 数组), resume_version(AI_SOLUTION/AI_CUSTOMER/IAM_AI/LLM_APP 之一或空字符串), "
        "pitch(一句招呼语)。"
    )

    resume_block = _load_resume_text(profile)
    resume_section = (
        f"\n\n## 候选人完整简历(权威信息源,以下与 summary 冲突时以此为准)\n{resume_block}\n"
        if resume_block else ""
    )

    user = f"""## 候选人 summary
{candidate.get('summary', '').strip()}
{resume_section}
目标月薪:最低 {candidate.get('target_monthly_min')},理想 {candidate.get('target_monthly_ideal')}。
S 级目标岗位:{candidate.get('s_tier_roles', [])}
A 级目标岗位:{candidate.get('a_tier_roles', [])}

## 岗位
公司:{job.company}
标题:{job.title}
城市:{job.city}
薪资:{job.salary}
JD:
{job.jd}

## 评分规则
0-100 分,权重:
- role_fit 30%(命中 S 级 → 满档加分;A 级 → 加分;纯算法/外包/培训类 → 大扣分)
- compensation_fit 25%(月薪低于 28K 大扣分;35K+ 满分)
- experience_fit 20%(1-3 年或 2-5 年加分;明确 5 年以上要求 → 扣分)
- tech_stack_fit 15%(LLM/RAG/Agent/Azure/Entra ID/FastAPI 加分)
- company_quality 10%(大厂/独角兽/外资加分;小公司无融资减分)

分档:S ≥ 90, A ≥ 70, B ≥ 55, C ≥ 40, Reject < 40。

## 北京软提示规则(重要)
若岗位城市是"北京",并且薪资相比上海/杭州同档同类岗位**高出比例不足 {int(premium * 100)}%**,
在 concerns 里追加一条:"北京无户口,薪资溢价不足({int(premium * 100)}%)"。
这只是软提示——**不要**因此把 priority 设为 Reject,也**不要**额外扣大分;仅在 concerns 里注明即可。

## 输出
仅输出严格 JSON 对象,不要任何解释、不要 markdown 包裹。"""

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _parse(raw: str | None, job: Job) -> ScoredJob:
    if not raw:
        return ScoredJob(
            job=job, score=0, priority="C",
            reason="LLM 返回为空", concerns=["LLM 返回为空"],
        )
    try:
        text = raw.strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.strip()
        data = json.loads(text)
    except json.JSONDecodeError:
        log.warning("score: JSON 解析失败,原文=%r", raw[:200])
        return ScoredJob(
            job=job, score=0, priority="C",
            reason="LLM JSON 解析失败", concerns=["LLM JSON 解析失败"],
        )

    priority = str(data.get("priority", "C")).strip()
    if priority not in _VALID_PRIORITIES:
        priority = "C"

    return ScoredJob(
        job=job,
        score=int(data.get("score", 0)),
        priority=priority,
        reason=str(data.get("reason", "")).strip() or "(无理由)",
        concerns=[str(c) for c in (data.get("concerns") or []) if c],
        resume_version=str(data.get("resume_version", "")).strip(),
        pitch=str(data.get("pitch", "")).strip(),
    )


async def _call_llm(messages: list[dict[str, str]]) -> str | None:
    last_err: Exception | None = None

    if deepseek_client is not None:
        for attempt in range(2):
            try:
                resp = await deepseek_client.chat.completions.create(
                    model="deepseek-chat",
                    messages=messages,
                    response_format={"type": "json_object"},
                    temperature=0.2,
                    timeout=30,
                )
                return resp.choices[0].message.content
            except Exception as e:
                last_err = e
                log.warning("deepseek attempt %d failed: %s", attempt + 1, e)

    if azure_client is not None and _AZURE_DEPLOYMENT:
        try:
            resp = await azure_client.chat.completions.create(
                model=_AZURE_DEPLOYMENT,
                messages=messages,
                response_format={"type": "json_object"},
                temperature=0.2,
                timeout=30,
            )
            return resp.choices[0].message.content
        except Exception as e:
            last_err = e
            log.error("azure fallback failed: %s", e)

    if last_err:
        log.error("All LLM providers failed for scoring: %s", last_err)
    return None


async def score_job(job: Job, profile: dict[str, Any]) -> ScoredJob:
    hit = hits_hard_reject(job, profile)
    if hit:
        return ScoredJob(
            job=job, score=0, priority="Reject",
            reason=f"命中 hard_reject 关键词: {hit}",
            concerns=[f"hard_reject: {hit}"],
        )

    async with _SEM:
        raw = await _call_llm(_build_messages(job, profile))
    return _parse(raw, job)


async def score_all(jobs: list[Job], profile: dict[str, Any]) -> list[ScoredJob]:
    return await asyncio.gather(*(score_job(j, profile) for j in jobs))
