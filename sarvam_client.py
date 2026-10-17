"""Thin wrappers around the Sarvam REST APIs: Document AI (Vision OCR) and Chat Completions."""
import io
import json
import os
import re
import time
import zipfile

import requests
from pypdf import PdfReader, PdfWriter

BASE_URL = "https://api.sarvam.ai"
MAX_PDF_PAGES = 10  # Document AI limit per job
TERMINAL_STATES = {"completed", "partially_completed", "failed", "rejected"}


class SarvamError(Exception):
    pass


def _headers():
    key = os.getenv("SARVAM_API_KEY", "")
    if not key or key == "your_sarvam_api_key_here":
        raise SarvamError("SARVAM_API_KEY is not set. Add it to the .env file and restart the server.")
    return {"api-subscription-key": key}


def _check(resp, what):
    if resp.status_code >= 400:
        raise SarvamError(f"{what} failed ({resp.status_code}): {resp.text[:500]}")
    return resp


# ---------------------------------------------------------------- Vision OCR

def _digitise_one(filename, data, mime, language, poll_timeout=600):
    """Run one Document AI digitise job and return the markdown text."""
    resp = requests.post(
        f"{BASE_URL}/doc-ai/v1/job/digitise",
        headers=_headers(),
        files={"file": (filename, data, mime)},
        data={"language": language, "output_format": "md"},
        timeout=120,
    )
    job_id = _check(resp, "Digitise job creation").json()["job_id"]

    deadline = time.time() + poll_timeout
    status = None
    while time.time() < deadline:
        st = _check(
            requests.get(f"{BASE_URL}/doc-ai/v1/job/{job_id}/status", headers=_headers(), timeout=30),
            "Status check",
        ).json()
        status = st.get("status")
        if status in TERMINAL_STATES:
            break
        time.sleep(2)
    else:
        raise SarvamError(f"OCR job {job_id} timed out")

    if status in ("failed", "rejected"):
        raise SarvamError(f"OCR job {job_id} {status}")

    dl = _check(
        requests.get(f"{BASE_URL}/doc-ai/v1/job/{job_id}/download-url", headers=_headers(), timeout=30),
        "Download URL",
    ).json()
    out = requests.request(dl.get("method", "GET"), dl["url"], headers=dl.get("headers") or {}, timeout=120)
    _check(out, "Downloading OCR output")

    # Output is a ZIP: primary .md file + metadata/ + manifest.json
    with zipfile.ZipFile(io.BytesIO(out.content)) as zf:
        md_files = [n for n in zf.namelist() if n.lower().endswith(".md") and not n.startswith("metadata/")]
        if not md_files:
            md_files = [n for n in zf.namelist() if n.lower().endswith((".md", ".html", ".txt"))]
        return "\n\n".join(zf.read(n).decode("utf-8", errors="replace") for n in sorted(md_files))


def ocr_document(filename, data, language="en-IN"):
    """OCR a PDF or image. PDFs longer than 10 pages are split into chunks."""
    lower = filename.lower()
    if lower.endswith((".png", ".jpg", ".jpeg")):
        mime = "image/png" if lower.endswith(".png") else "image/jpeg"
        return _digitise_one(filename, data, mime, language)

    reader = PdfReader(io.BytesIO(data))
    n = len(reader.pages)
    if n <= MAX_PDF_PAGES:
        return _digitise_one(filename, data, "application/pdf", language)

    parts = []
    for start in range(0, n, MAX_PDF_PAGES):
        writer = PdfWriter()
        for i in range(start, min(start + MAX_PDF_PAGES, n)):
            writer.add_page(reader.pages[i])
        buf = io.BytesIO()
        writer.write(buf)
        parts.append(_digitise_one(f"part{start}_{filename}", buf.getvalue(), "application/pdf", language))
    return "\n\n".join(parts)


# ---------------------------------------------------------------- Grading LLM

SYSTEM_PROMPT = """You are a strict, fair and consistent examiner helping a teaching assistant grade handwritten answer sheets.
The student's answer sheet was converted to text by OCR, so expect spelling mistakes, broken lines, odd symbols and missing formatting. Never penalise OCR noise; judge the underlying content.

Your job:
1. Read the whole answer sheet and figure out which part of the text answers which question in the marking scheme. Students may answer out of order, label questions differently (e.g. "Ans 2", "2)", "Q.2", "II"), or skip questions. Use labels first, then content, to match answers to questions.
2. For every question in the marking scheme, award marks ONLY for the rubric points that are actually present (fully or with clear equivalent meaning) in the student's answer. Partial credit for a rubric point is allowed only if the point is partially present, and must never exceed that point's marks.
3. A question that is not attempted gets 0.
4. Never award more than the question's maximum. Never invent content the student did not write.

5. Grading notes attached to a rubric point tell you how to award that point; follow them.
6. If the sheet shows the student's name or roll/registration number (usually at the top of the first page), copy it; otherwise use an empty string.

Respond with ONLY a single JSON object, no markdown fences, no extra text, in exactly this shape:
{
  "student_name": "<name written on the sheet, or empty string>",
  "roll_number": "<roll / registration number written on the sheet, or empty string>",
  "questions": [
    {
      "question_id": "<id exactly as given in the marking scheme>",
      "score": <number>,
      "max_score": <number>,
      "feedback": "<one or two sentences: which rubric points were met / missed>"
    }
  ],
  "total_score": <number, the sum of question scores>,
  "max_total": <number>,
  "overall_feedback": "<two or three sentences summarising the student's performance and the main things they missed>"
}"""


def _format_scheme(scheme):
    lines = []
    for q in scheme["questions"]:
        max_marks = sum(float(p["marks"]) for p in q["points"])
        title = f" — {q['title']}" if q.get("title") else ""
        lines.append(f"### Question {q['id']}{title}  (max {max_marks:g} marks)")
        if q.get("text"):
            lines.append(f"Question text / examiner hints: {q['text']}")
        lines.append("Rubric points (marks):")
        for p in q["points"]:
            note = f"  (grading note: {p['desc']})" if p.get("desc") else ""
            lines.append(f"- [{float(p['marks']):g}] {p['text']}{note}")
        lines.append("")
    return "\n".join(lines)


def _extract_json(text):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise SarvamError(f"Model did not return JSON: {text[:300]}")
        return json.loads(m.group(0))


def grade_answer(scheme, answer_text):
    """Ask the Sarvam LLM to grade one student's OCR'd answer sheet against the scheme."""
    user_prompt = (
        "MARKING SCHEME\n==============\n"
        + _format_scheme(scheme)
        + "\nSTUDENT ANSWER SHEET (OCR text)\n===============================\n"
        + (answer_text.strip() or "(empty — nothing could be read)")
        + "\n\nGrade this answer sheet now. Return only the JSON object."
    )
    body = {
        "model": os.getenv("SARVAM_CHAT_MODEL", "sarvam-105b"),
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "reasoning_effort": "low",
        "max_tokens": 8192,
    }
    last_err = None
    for _ in range(2):  # one retry if the model returns malformed JSON
        resp = requests.post(
            f"{BASE_URL}/v1/chat/completions",
            headers={**_headers(), "Content-Type": "application/json"},
            json=body,
            timeout=300,
        )
        content = _check(resp, "Grading").json()["choices"][0]["message"].get("content") or ""
        try:
            return _normalise(scheme, _extract_json(content))
        except (SarvamError, json.JSONDecodeError) as e:
            last_err = e
    raise SarvamError(f"Could not parse grading output: {last_err}")


def ping():
    """Cheap round-trip to confirm the API key and chat model work."""
    resp = requests.post(
        f"{BASE_URL}/v1/chat/completions",
        headers={**_headers(), "Content-Type": "application/json"},
        json={
            "model": os.getenv("SARVAM_CHAT_MODEL", "sarvam-105b"),
            "messages": [{"role": "user", "content": "Reply with the single word: ready"}],
            "reasoning_effort": None,
            "max_tokens": 10,
        },
        timeout=60,
    )
    return _check(resp, "Dry-check").json()["choices"][0]["message"].get("content") or ""


def _normalise(scheme, result):
    """Align model output to the scheme's question ids and clamp scores to their maximums."""
    by_id = {str(q.get("question_id", "")).strip().lower().lstrip("q"): q for q in result.get("questions", [])}
    questions = []
    for q in scheme["questions"]:
        max_marks = sum(float(p["marks"]) for p in q["points"])
        got = by_id.get(str(q["id"]).strip().lower().lstrip("q"), {})
        try:
            score = float(got.get("score", 0))
        except (TypeError, ValueError):
            score = 0.0
        score = max(0.0, min(score, max_marks))
        questions.append({
            "question_id": q["id"],
            "score": round(score, 2),
            "max_score": max_marks,
            "feedback": got.get("feedback") or ("" if got else "Not attempted / not found."),
        })
    return {
        "student_name": str(result.get("student_name") or "").strip(),
        "roll_number": str(result.get("roll_number") or "").strip(),
        "questions": questions,
        "total_score": round(sum(q["score"] for q in questions), 2),
        "max_total": sum(q["max_score"] for q in questions),
        "overall_feedback": result.get("overall_feedback", ""),
    }
