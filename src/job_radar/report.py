from __future__ import annotations

from collections import Counter

from .models import ScoredJob


def _fmt(item: ScoredJob, idx: int) -> str:
    j = item.job
    lines = [
        f"{idx}. **{j.company} - {j.title}**",
        f"   📍 {j.city} · 💰 {j.salary} · 📊 {item.score}/100",
        f"   > {item.reason}",
    ]
    if item.concerns:
        lines.append(f"   ⚠️ {' / '.join(item.concerns)}")
    if item.pitch:
        lines.append(f"   💬 建议话术:{item.pitch}")
    if j.url:
        lines.append(f"   🔗 [查看岗位]({j.url})")
    return "\n".join(lines)


def _reject_summary(rejects: list[ScoredJob]) -> list[str]:
    salary, exp, algo, other = 0, 0, 0, 0
    for r in rejects:
        blob = (r.reason + " " + " ".join(r.concerns)).lower()
        if any(k in blob for k in ("薪资", "salary", "月薪")):
            salary += 1
        elif any(k in blob for k in ("经验", "年限", "5 年")):
            exp += 1
        elif any(k in blob for k in ("算法", "外包", "驻场", "标注", "培训")):
            algo += 1
        else:
            other += 1
    out = []
    if salary: out.append(f"- 薪资不达标:{salary} 条")
    if exp:    out.append(f"- 经验要求过高:{exp} 条")
    if algo:   out.append(f"- 疑似算法/外包/培训:{algo} 条")
    if other:  out.append(f"- 其他原因:{other} 条")
    return out


def build_compact_report(scored: list[ScoredJob], date_str: str, local_path: str | None = None) -> tuple[str, dict]:
    """One-liner-per-job format for WxPusher push.

    Drops reasons/concerns/pitch to fit ~50 jobs in 4KB. Full details live in
    `build_report` output saved to disk; the footer points readers there.
    """
    by_prio: dict[str, list[ScoredJob]] = {"S": [], "A": [], "B": [], "C": [], "Reject": []}
    for s in scored:
        by_prio.setdefault(s.priority, []).append(s)
    for prio in by_prio:
        by_prio[prio].sort(key=lambda x: x.score, reverse=True)

    total = len(scored)
    counts = Counter(s.priority for s in scored)
    s_count = counts.get("S", 0)
    a_count = counts.get("A", 0)

    lines = [
        f"## 🎯 求职日报 {date_str}",
        f"> 共 {total} | S={s_count} | A={a_count} | B={counts.get('B', 0)} | C={counts.get('C', 0)} | R={counts.get('Reject', 0)}",
        "",
    ]

    def emit_tier(prio: str, label: str) -> None:
        items = by_prio.get(prio) or []
        if not items:
            return
        lines.append(f"### {label} ({len(items)})")
        for s in items:
            j = s.job
            lines.append(f"[{s.score}] {j.title} — {j.salary} — {j.city}")
            if j.url:
                lines.append(j.url)
            lines.append("")

    emit_tier("S", "🌟 S")
    emit_tier("A", "🟢 A")
    emit_tier("B", "🟡 B")

    if local_path:
        lines.append(f"---\n完整版含理由: `{local_path}`")

    md = "\n".join(lines).rstrip() + "\n"
    return md, {"total": total, "s_count": s_count, "a_count": a_count}


def build_report(scored: list[ScoredJob], date_str: str) -> tuple[str, dict]:
    by_prio: dict[str, list[ScoredJob]] = {"S": [], "A": [], "B": [], "C": [], "Reject": []}
    for s in scored:
        by_prio.setdefault(s.priority, []).append(s)

    for prio in by_prio:
        by_prio[prio].sort(key=lambda x: x.score, reverse=True)

    total = len(scored)
    counts = Counter(s.priority for s in scored)
    s_count = counts.get("S", 0)
    a_count = counts.get("A", 0)

    lines = [
        f"## 🎯 今日岗位雷达 - {date_str}",
        f"> 采集 {total} 个 | S 级 {s_count} | A 级 {a_count} | B 级 {counts.get('B', 0)} | C 级 {counts.get('C', 0)} | Reject {counts.get('Reject', 0)}",
        "",
    ]

    if by_prio["S"]:
        lines.append("### 🔥 S 级(今日优先投)")
        for i, s in enumerate(by_prio["S"], 1):
            lines.append(_fmt(s, i))
            lines.append("")

    if by_prio["A"]:
        lines.append("### ⭐ A 级(值得投)")
        for i, s in enumerate(by_prio["A"], 1):
            lines.append(_fmt(s, i))
            lines.append("")

    if by_prio["B"]:
        lines.append("### 💡 B 级(可以看看)")
        for i, s in enumerate(by_prio["B"], 1):
            lines.append(_fmt(s, i))
            lines.append("")

    rejects = by_prio["C"] + by_prio["Reject"]
    if rejects:
        lines.append("### 📋 已排除摘要")
        lines.extend(_reject_summary(rejects))
        lines.append("")

    md = "\n".join(lines).rstrip() + "\n"
    return md, {"total": total, "s_count": s_count, "a_count": a_count}
