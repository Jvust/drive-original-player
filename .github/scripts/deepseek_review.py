from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

API_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-v4-pro"
FILES = ["index.html", "sw.js"]

SYSTEM = r'''
You are the first-pass production code reviewer for a static GitHub Pages Google Drive original-file video player.
Inspect the supplied index.html and sw.js for REAL defects only. Do not rewrite for style. Return at most 6 findings, prioritizing high-confidence issues that could materially affect users.

Preserve these constraints:
- original media bytes only; no quality-reducing transcoding;
- Google Drive HTTP Range streaming through a Service Worker;
- native video smoothness on mobile/tablet has priority over WebGPU enhancement;
- V10 intentionally uses two-video hot standby, decoded-first-frame readiness, same-folder early discovery, WebGPU visual bridging, and adjacent-prefix preloading;
- Seek Rescue is only for structurally difficult MP4 files;
- recursive folder scanning/background work must yield to active playback.

Priorities:
1. hot-switch false-ready states or avoidable latency;
2. Service Worker Range/cache/auth/abort/race correctness;
3. seek stalls and scrub-prime interactions;
4. duplicate bandwidth work;
5. WebGPU/native-video handoff races;
6. rapid switching/seeking/fullscreen lifecycle races;
7. leaks or unbounded caches/listeners/timers.

Return one JSON object only:
{
  "verdict": "PASS|PASS_WITH_FIXES|NEEDS_FIXES",
  "summary": "short technical summary",
  "findings": [{
    "severity": "critical|high|medium|low",
    "confidence": "high|medium|low",
    "file": "exact path",
    "line_hint": "function/constant/event or nearby phrase",
    "title": "concise defect title",
    "evidence": "what the code actually does",
    "user_impact": "observable consequence",
    "minimal_fix": "smallest safe change",
    "test_plan": "specific verification"
  }],
  "hot_switch_assessment": "specific assessment",
  "seek_assessment": "specific assessment",
  "service_worker_assessment": "specific assessment",
  "do_not_change": ["already-correct mechanisms worth preserving"]
}
'''.strip()


def source_packet() -> str:
    chunks = []
    for name in FILES:
        path = Path(name)
        if not path.exists():
            raise SystemExit(f"missing required file: {name}")
        chunks.append(f"\n\n===== FILE: {name} =====\n{path.read_text(encoding='utf-8')}")
    return "".join(chunks)


def call(body: dict[str, Any], key: str) -> tuple[dict[str, Any], float]:
    last_error = "unknown provider error"
    for attempt in range(1, 3):
        req = urllib.request.Request(
            API_URL,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=600) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("provider returned non-object envelope")
            return payload, time.perf_counter() - started
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last_error = f"HTTP {exc.code}: {detail[:1200]}"
            if exc.code not in {429, 500, 502, 503, 504} or attempt == 2:
                break
        except urllib.error.URLError as exc:
            last_error = f"connection error: {exc}"
            if attempt == 2:
                break
        time.sleep(3)
    raise RuntimeError(last_error)


def extract(envelope: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    choices = envelope.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ValueError("no valid choices[0]")
    choice = choices[0]
    message = choice.get("message")
    if not isinstance(message, dict):
        raise ValueError("no valid assistant message")
    content = message.get("content")
    if not isinstance(content, str):
        content = ""
    reasoning = message.get("reasoning_content")
    return content.strip(), {
        "finish_reason": choice.get("finish_reason"),
        "reasoning_present": isinstance(reasoning, str) and bool(reasoning),
        "reasoning_char_count": len(reasoning) if isinstance(reasoning, str) else 0,
        "usage": envelope.get("usage") if isinstance(envelope.get("usage"), dict) else {},
    }


def parse_json(text: str) -> dict[str, Any]:
    value = text.strip()
    if value.startswith("```"):
        lines = value.splitlines()
        lines = lines[1:] if lines and lines[0].startswith("```") else lines
        lines = lines[:-1] if lines and lines[-1].strip() == "```" else lines
        value = "\n".join(lines).strip()
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        start, end = value.find("{"), value.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(value[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("review output is not a JSON object")
    return parsed


def body(user: str, *, json_mode: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
        ],
        "thinking": {"type": "disabled"},
        "max_tokens": 12000,
        "stream": False,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    return payload


def write_error(message: str, attempts: list[dict[str, Any]]) -> None:
    Path("deepseek-review-error.json").write_text(
        json.dumps({"error": message, "attempts": attempts}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def markdown(report: dict[str, Any], meta: dict[str, Any]) -> str:
    findings = report.get("findings") if isinstance(report.get("findings"), list) else []
    out = [
        "# DeepSeek V4-Pro V10 Core Screening",
        "",
        f"**Verdict:** {report.get('verdict', 'UNKNOWN')}",
        "",
        str(report.get("summary", "")),
        "",
        f"**Findings:** {len(findings)}",
        "",
    ]
    for i, item in enumerate(findings, 1):
        if not isinstance(item, dict):
            continue
        out.extend([
            f"## {i}. [{str(item.get('severity', '?')).upper()}] {item.get('title', 'Untitled')}",
            f"- Confidence: {item.get('confidence', '?')}",
            f"- File: `{item.get('file', '?')}`",
            f"- Location: `{item.get('line_hint', '?')}`",
            f"- Evidence: {item.get('evidence', '')}",
            f"- User impact: {item.get('user_impact', '')}",
            f"- Minimal fix: {item.get('minimal_fix', '')}",
            f"- Test: {item.get('test_plan', '')}",
            "",
        ])
    out.extend([
        "## Focus assessments",
        f"- Hot switch: {report.get('hot_switch_assessment', '')}",
        f"- Seek: {report.get('seek_assessment', '')}",
        f"- Service Worker: {report.get('service_worker_assessment', '')}",
        "",
        "## Provider metadata",
        f"- Mode: V4-Pro non-thinking screening / {meta.get('successful_mode')}",
        f"- Latency: {meta.get('latency_seconds')} s",
        f"- Finish reason: {meta.get('finish_reason')}",
        "",
        "> API key and reasoning_content are never persisted. High-value findings should be independently verified before code changes.",
    ])
    return "\n".join(out)


def main() -> int:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise SystemExit("DEEPSEEK_API_KEY is missing")

    base_user = "Perform the first-pass review. Return JSON.\n" + source_packet()
    attempts: list[dict[str, Any]] = []

    for mode, json_mode in (("json_mode", True), ("plain_json_fallback", False)):
        user = base_user if json_mode else base_user + "\n\nReturn one raw JSON object only; no markdown fences."
        try:
            envelope, latency = call(body(user, json_mode=json_mode), key)
            content, meta = extract(envelope)
            attempts.append({
                "mode": mode,
                "latency_seconds": round(latency, 2),
                "finish_reason": meta.get("finish_reason"),
                "content_char_count": len(content),
                "usage": meta.get("usage"),
            })
            print(f"DeepSeek {mode}: {latency:.1f}s, content={len(content)}, finish={meta.get('finish_reason')}")
            if not content:
                continue
            try:
                report = parse_json(content)
            except Exception as exc:
                attempts[-1]["parse_error"] = f"{type(exc).__name__}: {exc}"
                continue

            full_meta = {
                **meta,
                "successful_mode": mode,
                "latency_seconds": round(latency, 2),
                "attempts": attempts,
            }
            Path("deepseek-review.json").write_text(
                json.dumps({"report": report, "metadata": full_meta}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            md = markdown(report, full_meta)
            Path("deepseek-review.md").write_text(md, encoding="utf-8")
            summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
            if summary_path:
                with open(summary_path, "a", encoding="utf-8") as fh:
                    fh.write(md)
            return 0
        except Exception as exc:
            attempts.append({"mode": mode, "request_error": f"{type(exc).__name__}: {exc}"})

    write_error("DeepSeek returned no usable JSON", attempts)
    raise SystemExit("DeepSeek returned no usable JSON")


if __name__ == "__main__":
    raise SystemExit(main())
