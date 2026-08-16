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
You are a senior Chromium media-pipeline, Service Worker, JavaScript, WebGPU, MSE/MP4, and Google Drive HTTP Range reviewer.

Review the supplied production source for REAL defects only. Do not rewrite for style. Prefer a small number of high-confidence findings.

Product constraints to preserve:
- Static GitHub Pages Google Drive original-file player.
- Media stays original bytes; no quality-reducing transcoding.
- Google Drive byte-range streaming through a Service Worker.
- Mobile/tablet smooth native video playback has priority over WebGPU enhancement.
- V10 intentionally uses two-video hot standby, decoded-first-frame readiness, same-folder early discovery, a WebGPU visual bridge, and adjacent prefix preloading.
- Seek Rescue is only for structurally difficult MP4; healthy seek stays native.
- Recursive folder scanning must not block current playback.
- Background/gallery work must yield to active media work.

Attack these areas first:
1. next-video hot-switch latency and false-ready states;
2. Service Worker Range/cache/auth/abort/race correctness;
3. seek stalls, especially non-interleaved MP4 and scrub-prime interactions;
4. duplicate network work or bandwidth contention;
5. WebGPU/native-video handoff races and stale-frame exposure;
6. rapid-switch/seek/fullscreen lifecycle races;
7. memory leaks, detached media objects, unbounded caches/listeners/timers.

Return exactly one JSON object with this shape:
{
  "verdict": "PASS|PASS_WITH_FIXES|NEEDS_FIXES",
  "summary": "short technical summary",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "file": "exact file path",
      "line_hint": "function/constant/event name or nearby code phrase",
      "title": "concise defect title",
      "evidence": "what the code actually does and why this is a defect",
      "user_impact": "observable consequence",
      "minimal_fix": "smallest safe change",
      "test_plan": "specific verification steps"
    }
  ],
  "hot_switch_assessment": "specific assessment",
  "seek_assessment": "specific assessment",
  "service_worker_assessment": "specific assessment",
  "do_not_change": ["things already correct and worth preserving"]
}
Do not include commentary outside the JSON object.
'''.strip()


def build_source() -> str:
    parts: list[str] = []
    for name in FILES:
        path = Path(name)
        if not path.exists():
            raise SystemExit(f"Required file is missing: {name}")
        parts.append(f"\n\n===== FILE: {name} =====\n{path.read_text(encoding='utf-8')}")
    return "".join(parts)


def request_once(body: dict[str, Any], api_key: str) -> tuple[dict[str, Any], float]:
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=600) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload, time.perf_counter() - started


def call_with_transport_retry(body: dict[str, Any], api_key: str) -> tuple[dict[str, Any], float, int]:
    last_error = "unknown error"
    for attempt in range(1, 3):
        try:
            payload, latency = request_once(body, api_key)
            return payload, latency, attempt
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last_error = f"HTTP {exc.code}: {detail[:1200]}"
            if exc.code not in {429, 500, 502, 503, 504} or attempt == 2:
                break
        except urllib.error.URLError as exc:
            last_error = f"Connection error: {exc}"
            if attempt == 2:
                break
        time.sleep(3)
    raise RuntimeError(last_error)


def extract_message(envelope: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    choices = envelope.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ValueError("DeepSeek returned no valid choices[0]")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ValueError("DeepSeek returned no valid message")
    content = message.get("content")
    if not isinstance(content, str):
        content = ""
    reasoning = message.get("reasoning_content")
    meta = {
        "finish_reason": choices[0].get("finish_reason"),
        "reasoning_present": isinstance(reasoning, str) and bool(reasoning),
        "reasoning_char_count": len(reasoning) if isinstance(reasoning, str) else 0,
        "usage": envelope.get("usage") if isinstance(envelope.get("usage"), dict) else {},
    }
    return content.strip(), meta


def parse_json_content(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("DeepSeek review is not a JSON object")
    return parsed


def build_body(user: str, *, json_mode: bool) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
        ],
        "thinking": {"type": "enabled"},
        "reasoning_effort": "high",
        "max_tokens": 24000,
        "stream": False,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    return body


def write_error(message: str, attempts: list[dict[str, Any]]) -> None:
    Path("deepseek-review-error.json").write_text(
        json.dumps({"error": message, "attempts": attempts}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def render_markdown(report: dict[str, Any], metadata: dict[str, Any]) -> str:
    findings = report.get("findings") if isinstance(report.get("findings"), list) else []
    rows = [
        "# DeepSeek V4-Pro V10 Core Review",
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
        rows.extend([
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
    rows.extend([
        "## Focus assessments",
        f"- Hot switch: {report.get('hot_switch_assessment', '')}",
        f"- Seek: {report.get('seek_assessment', '')}",
        f"- Service Worker: {report.get('service_worker_assessment', '')}",
        "",
        "## Provider metadata",
        f"- Successful mode: {metadata.get('successful_mode')}",
        f"- Latency: {metadata.get('latency_seconds')} s",
        f"- Finish reason: {metadata.get('finish_reason')}",
        f"- Reasoning present: {metadata.get('reasoning_present')}",
        f"- Reasoning chars (not persisted): {metadata.get('reasoning_char_count')}",
        "",
        "> API key and reasoning_content are never written to artifacts.",
    ])
    return "\n".join(rows)


def main() -> int:
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("DEEPSEEK_API_KEY is missing")

    source = build_source()
    base_user = "Review the current V10 core source below. Base every finding on the supplied code. Return JSON.\n" + source
    attempt_log: list[dict[str, Any]] = []

    for mode in ("json_mode", "plain_json_fallback"):
        json_mode = mode == "json_mode"
        user = base_user
        if not json_mode:
            user += "\n\nIMPORTANT: Return one raw JSON object only. Do not use markdown fences."
        try:
            envelope, latency, transport_attempts = call_with_transport_retry(
                build_body(user, json_mode=json_mode), api_key
            )
            content, meta = extract_message(envelope)
            attempt_log.append({
                "mode": mode,
                "latency_seconds": round(latency, 2),
                "transport_attempts": transport_attempts,
                "finish_reason": meta.get("finish_reason"),
                "content_char_count": len(content),
                "reasoning_present": meta.get("reasoning_present"),
                "reasoning_char_count": meta.get("reasoning_char_count"),
                "usage": meta.get("usage"),
            })
            print(
                f"DeepSeek {mode} completed in {latency:.1f}s; "
                f"content={len(content)} chars; finish={meta.get('finish_reason')}"
            )
            if not content:
                continue
            try:
                report = parse_json_content(content)
            except Exception as exc:
                attempt_log[-1]["parse_error"] = f"{type(exc).__name__}: {exc}"
                continue

            metadata = {
                **meta,
                "successful_mode": mode,
                "latency_seconds": round(latency, 2),
                "attempts": attempt_log,
            }
            Path("deepseek-review.json").write_text(
                json.dumps({"report": report, "metadata": metadata}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            markdown = render_markdown(report, metadata)
            Path("deepseek-review.md").write_text(markdown, encoding="utf-8")
            summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
            if summary_path:
                with open(summary_path, "a", encoding="utf-8") as fh:
                    fh.write(markdown)
            return 0
        except Exception as exc:
            attempt_log.append({"mode": mode, "request_error": f"{type(exc).__name__}: {exc}"})

    write_error("DeepSeek returned no usable final JSON after fallback", attempt_log)
    raise SystemExit("DeepSeek returned no usable final JSON after fallback")


if __name__ == "__main__":
    raise SystemExit(main())
