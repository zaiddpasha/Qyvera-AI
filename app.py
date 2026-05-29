from flask import Flask, render_template, request, jsonify, redirect, session, send_from_directory, Response, stream_with_context
import sqlite3
import os
import requests
import json
import time
from urllib.parse import urlencode, quote_plus, quote
from dotenv import load_dotenv
from werkzeug.utils import secure_filename
import uuid
import re
import tempfile
try:
    from groq import Groq
except ImportError:
    Groq = None

try:
    from pypdf import PdfMerger, PdfReader
except ImportError:
    try:
        from PyPDF2 import PdfMerger, PdfReader
    except ImportError:
        PdfMerger = None
        PdfReader = None
try:
    from PIL import Image
except ImportError:
    Image = None
try:
    from PIL import ImageEnhance, ImageFilter
except ImportError:
    ImageEnhance = None
    ImageFilter = None
try:
    import pytesseract
except ImportError:
    pytesseract = None
try:
    from pdf2image import convert_from_path
except ImportError:
    convert_from_path = None

load_dotenv()

def env(name):
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def _groq_model_candidates():
    preferred = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip() or "llama-3.3-70b-versatile"
    candidates = [preferred]
    if preferred != "llama-3.1-8b-instant":
        candidates.append("llama-3.1-8b-instant")
    return candidates


def _stream_groq_chat(messages):
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key or Groq is None:
        return

    client = Groq(api_key=api_key)

    last_error = None
    for model_name in _groq_model_candidates():
        try:
            stream = client.chat.completions.create(
                model=model_name,
                messages=messages,
                stream=True,
                max_tokens=4096
            )

            for chunk in stream:
                if not chunk.choices:
                    continue

                token = getattr(chunk.choices[0].delta, "content", None)

                if token:
                    yield token
            return
        except Exception as e:
            last_error = e
            continue

    if last_error:
        print("GROQ ERROR:", last_error)

def _call_groq_chat(messages):
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key or Groq is None:
        return None

    client = Groq(api_key=api_key)

    for model_name in _groq_model_candidates():
        try:
            response = client.chat.completions.create(
                model=model_name,
                messages=messages,
                max_tokens=4096
            )
            return response.choices[0].message.content
        except Exception:
            continue
    return None        



app = Flask(__name__)
app.secret_key = "dev-secret-key-change-later"
DB_PATH = "users.db"
ALLOWED_UPLOAD_EXT = {"pdf", "png", "jpg", "jpeg", "webp"}
ALLOWED_UPLOAD_MIME = {"application/pdf", "image/png", "image/jpg", "image/jpeg", "image/webp"}
MERGED_DIR = os.path.join(tempfile.gettempdir(), "qyvera_merged_files")
TEMP_UPLOAD_DIR = "temp_uploads"
MERGED_FILE_OWNERS = {}
CONVERTED_FILE_OWNERS = {}
CONVERSATION_UPLOADS = {}
MAX_UPLOADS_PER_CONVERSATION = 50
MERGE_PDF_PATTERN = re.compile(r"\b(merge|combine)\b", re.IGNORECASE)
SUMMARIZE_PDF_PATTERN = re.compile(r"\bsummarize\b", re.IGNORECASE)
CONVERT_IMAGE_PATTERN = re.compile(r"\bconvert\b", re.IGNORECASE)
OCR_EXTRACT_PATTERN = re.compile(r"\b(extract text|read text|get text|ocr)\b", re.IGNORECASE)
TARGET_IMAGE_FORMAT_PATTERN = re.compile(r"\b(?:to|into|as)\s+(png|jpe?g|webp|pdf)\b", re.IGNORECASE)
TARGET_IMAGE_FORMAT_FALLBACK_PATTERN = re.compile(r"\b(png|jpe?g|webp|pdf)\b", re.IGNORECASE)
SUMMARIZER_ROUTE_PATTERN = re.compile(r"\b(summarize|summary|explain document)\b", re.IGNORECASE)
CONVERTER_ROUTE_PATTERN = re.compile(r"\bconvert\b", re.IGNORECASE)
MERGE_ROUTE_PATTERN = re.compile(r"\bmerge\b", re.IGNORECASE)
PDF_ROUTE_PATTERN = re.compile(r"\bpdf\b", re.IGNORECASE)
OCR_ROUTE_PATTERN = re.compile(r"\b(extract text|read text|ocr)\b", re.IGNORECASE)
IMAGE_REQUEST_PATTERN = re.compile(r"\b(image|images|photo|photos|picture|pictures|pic|pics|wallpaper|wallpapers)\b", re.IGNORECASE)
LINK_REQUEST_PATTERN = re.compile(r"\b(link|links|url|urls|source|download)\b", re.IGNORECASE)
IMAGE_OF_REQUEST_PATTERN = re.compile(
    r"\b(images?|photos?|pictures?|pics?|wallpapers?)\s+(of|for)\b|\b(show|give|send)\b.*\b(images?|photos?|pictures?|pics?|wallpapers?)\b",
    re.IGNORECASE
)
PERSON_HINT_PATTERN = re.compile(
    r"\b(who is|biography|bio|person|politician|actor|actress|athlete|sports|celebrity|leader|prime minister|president)\b",
    re.IGNORECASE
)
COMPARISON_REQUEST_PATTERN = re.compile(
    r"\b(compare|comparison|difference|differentiate|diff|vs|versus|between)\b",
    re.IGNORECASE
)
SIMPLE_GREETING_PATTERN = re.compile(
    r"^\s*(hi+|hello+|hey+|good morning|good afternoon|good evening|how are you|how are you doing|how's it going|are you fine|are you okay|all good|what's up|sup)\s*[!.?]*\s*$",
    re.IGNORECASE
)
TABLE_ROW_ONLY_PATTERN = re.compile(r"^\s*\|.*\|\s*$")


def _clean_ai_plain_text(text):
    cleaned = str(text or "")
    cleaned = cleaned.replace("\r", "")
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned


def _is_comparison_request(text):
    return bool(COMPARISON_REQUEST_PATTERN.search(str(text or "")))


def _is_simple_greeting(text):
    return bool(SIMPLE_GREETING_PATTERN.match(str(text or "")))


def _normalize_user_message_for_ai(text):
    message = str(text or "").strip()
    if not message:
        return message

    normalized = message
    if re.search(r"\bbrief(?:ly)?\b|\bconcise\b|\bshort\b", normalized, flags=re.IGNORECASE):
        normalized += (
            "\n\n"
            "Interpret brief as compact but still properly explained. "
            "Give a useful answer with a short definition, key points, and enough detail to understand the topic."
        )
    return normalized


def _normalize_noncomparison_output(text):
    cleaned = str(text or "").replace("\r", "")
    lines = cleaned.split("\n")
    normalized_lines = []
    saw_table_like = False

    for line in lines:
        stripped = line.strip()
        if not stripped:
            normalized_lines.append(line)
            continue
        if re.fullmatch(r"\|?(?:\s*:?-{3,}:?\s*\|)+\s*", stripped):
            saw_table_like = True
            continue
        if TABLE_ROW_ONLY_PATTERN.match(stripped):
            saw_table_like = True
            cells = [cell.strip() for cell in stripped.strip("|").split("|") if cell.strip()]
            if len(cells) >= 2:
                normalized_lines.append(f"{cells[0]}: {' | '.join(cells[1:])}")
            elif cells:
                normalized_lines.append(cells[0])
            continue
        normalized_lines.append(line)

    normalized = "\n".join(normalized_lines)
    normalized = re.sub(r"^\s*(\d+)\.\s*[-:]\s*$", "", normalized, flags=re.MULTILINE)
    normalized = re.sub(r"(^|\n)(\d+)\.\.(?=\s*\S)", r"\1\2. ", normalized)
    normalized = re.sub(
        r"(?<=[a-z0-9)])\s+(\d+)\.\s+(?=[A-Z][A-Za-z0-9 /&()'_-]{2,80}:)",
        r"\n\n\1. ",
        normalized,
    )
    normalized = re.sub(
        r"(?<=[a-z0-9)])\s+(\d+)\.\.\s+(?=[A-Z][A-Za-z0-9 /&()'_-]{2,80}:)",
        r"\n\n\1. ",
        normalized,
    )
    normalized = re.sub(r"\n{3,}", "\n\n", normalized).strip()
    if saw_table_like:
        normalized = re.sub(r"\n{3,}", "\n\n", normalized).strip()
    return _enhance_noncomparison_markdown(normalized)


def _enhance_noncomparison_markdown(text):
    content = str(text or "").replace("\r", "").strip()
    if not content:
        return content
    if "```" in content:
        return content
    if re.search(r"(^|\n)#{1,6}\s+", content):
        return content
    if re.search(r"!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)", content):
        return content
    if re.search(r"^\s*\|.*\|\s*$", content, flags=re.MULTILINE):
        return content
    if (
        len(content) <= 220
        and "\n" not in content
        and not re.search(r"(^|\n)\s*(?:[-*]\s+|\d+\.\s+)", content)
    ):
        return content

    paragraphs = [p.strip() for p in re.split(r"\n{2,}", content) if p.strip()]
    if not paragraphs:
        return content
    if len(paragraphs) == 1 and not re.search(r"(^|\n)\s*(?:[-*]|\d+\.)\s+", content):
        return content

    structured = []
    section_count = 0
    for paragraph in paragraphs:
        lines = [line.strip() for line in paragraph.split("\n") if line.strip()]
        if not lines:
            continue

        heading_match = re.fullmatch(r"[A-Za-z][A-Za-z0-9 /&()'_-]{2,80}:?", lines[0])
        list_tail = len(lines) > 1 and all(re.match(r"^(?:[-*]|\d+\.)\s+", line) for line in lines[1:])

        if heading_match and list_tail:
            if section_count > 0:
                structured.append("---")
            structured.append(f"### {lines[0].rstrip(':')}")
            structured.extend(lines[1:])
            section_count += 1
            continue

        if heading_match and len(lines) == 1:
            if section_count > 0:
                structured.append("---")
            structured.append(f"### {lines[0].rstrip(':')}")
            section_count += 1
            continue

        if all(re.match(r"^(?:[-*]|\d+\.)\s+", line) for line in lines):
            if section_count > 0 and structured and structured[-1] != "---":
                structured.append("---")
            structured.extend(lines)
            section_count += 1
            continue

        structured.append(paragraph)
        section_count += 1

    return "\n\n".join(part for part in structured if part)


# ================= DB INIT (ADDED) =================
def init_db():
    conn = sqlite3.connect("chat.db")
    cur = conn.cursor()

    cur.execute("""
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    conversation_id TEXT,
    role TEXT,
    content TEXT
)
""")

    cur.execute("""
CREATE TABLE IF NOT EXISTS message_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    conversation_id TEXT,
    message_id INTEGER,
    role TEXT,
    file_name TEXT,
    file_path TEXT,
    file_mime TEXT,
    is_download INTEGER DEFAULT 0
)
""")

    conn.commit()
    conn.close()

init_db()
os.makedirs(MERGED_DIR, exist_ok=True)
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)


def _remove_attachment_file_if_exists(path):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


def _extract_target_image_format(lower_msg):
    if not lower_msg:
        return ""
    match = TARGET_IMAGE_FORMAT_PATTERN.search(lower_msg)
    if not match:
        match = TARGET_IMAGE_FORMAT_FALLBACK_PATTERN.search(lower_msg)
    if not match:
        return ""
    fmt = (match.group(1) or "").lower()
    if fmt == "jpeg":
        return "jpg"
    return fmt


def _route_tool_intent(lower_msg):
    msg = lower_msg or ""
    target_fmt = _extract_target_image_format(msg)

    if MERGE_ROUTE_PATTERN.search(msg) and PDF_ROUTE_PATTERN.search(msg):
        return "pdf_merge", target_fmt

    if CONVERTER_ROUTE_PATTERN.search(msg):
        mentions_image = bool(re.search(r"\bimage\b", msg))
        if mentions_image or target_fmt in {"png", "jpg", "webp", "pdf"}:
            return "image_convert", target_fmt

    if SUMMARIZER_ROUTE_PATTERN.search(msg):
        return "summarize", target_fmt

    if OCR_ROUTE_PATTERN.search(msg):
        return "ocr", target_fmt

    return None, target_fmt


def _extract_image_query_text(user_msg):
    text = str(user_msg or "").strip()
    if not text:
        return "images"
    text = re.sub(r"\b(show|give|find|send|need|want)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(me|some|a|an|the|of|for|to|please|with|and)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(image|images|photo|photos|picture|pictures|pic|pics|wallpaper|wallpapers)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(link|links|url|urls|source|download)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip(" ,.-")
    lower_text = text.lower()
    # Normalize common fashion query spellings for better image relevance.
    if re.search(r"\bh\s*&?\s*m\b", lower_text):
        text = re.sub(r"\bh\s*&?\s*m\b", "h&m", text, flags=re.IGNORECASE)
    text = re.sub(r"\bcloths\b", "clothes", text, flags=re.IGNORECASE)
    if re.search(r"\bh&m\b", text, flags=re.IGNORECASE) and not re.search(r"\bclothes?\b|\bfashion\b|\boutfit\b", text, flags=re.IGNORECASE):
        text = f"{text} clothing"
    return text or "images"


def _is_person_like_query(text):
    raw = str(text or "").strip()
    if not raw:
        return False
    lower = raw.lower()
    if PERSON_HINT_PATTERN.search(lower):
        return True
    if IMAGE_REQUEST_PATTERN.search(lower):
        return False
    cleaned = re.sub(r"[^a-zA-Z\s\.\-']", " ", raw)
    tokens = [t for t in cleaned.split() if t]
    if not (2 <= len(tokens) <= 4):
        return False
    stop = {
        "the", "a", "an", "of", "for", "in", "on", "with",
        "car", "bike", "fruit", "flower", "city", "country", "product", "model"
    }
    if any(t.lower() in stop for t in tokens):
        return False
    # Person-name style: mostly alphabetic words with at least one longer token.
    alpha_ok = all(re.match(r"^[A-Za-z][A-Za-z\.\-']*$", t) for t in tokens)
    has_length = any(len(t) >= 5 for t in tokens)
    return alpha_ok and has_length


def _extract_person_query_text(user_msg):
    text = str(user_msg or "").strip()
    if not text:
        return ""
    text = re.sub(
        r"\b(who is|about|biography|bio|image|images|photo|photos|picture|pictures|of|for|please|show|give|send)\b",
        " ",
        text,
        flags=re.IGNORECASE
    )
    text = re.sub(r"\s+", " ", text).strip(" ,.-")
    return text


def _fetch_wikipedia_summary_and_image(query):
    if not query:
        return {"summary": "", "image": "", "description": "", "title": ""}
    try:
        wiki_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote(query)}"
        res = requests.get(wiki_url, timeout=8)
        if res.status_code != 200:
            return {"summary": "", "image": "", "description": "", "title": ""}
        data = res.json() or {}
        summary = re.sub(r"\s+", " ", str(data.get("extract") or "")).strip()
        summary = summary[:340].rstrip(". ") + "." if summary else ""
        image = ((data.get("thumbnail") or {}).get("source") or "").strip()
        description = re.sub(r"\s+", " ", str(data.get("description") or "")).strip().lower()
        title = str(data.get("title") or "").strip()
        return {
            "summary": summary,
            "image": image,
            "description": description,
            "title": title
        }
    except Exception:
        return {"summary": "", "image": "", "description": "", "title": ""}


def _is_person_wiki_entry(wiki_data):
    desc = str((wiki_data or {}).get("description") or "").lower()
    summary = str((wiki_data or {}).get("summary") or "").lower()
    blob = f"{desc} {summary}"
    if not blob.strip():
        return False
    person_markers = (
        "politician", "actor", "actress", "singer", "musician", "athlete",
        "cricketer", "footballer", "player", "writer", "author", "poet",
        "scientist", "engineer", "businessman", "businesswoman", "ceo",
        "prime minister", "president", "minister", "biography", "person",
        "indian", "american", "british", "born"
    )
    return any(marker in blob for marker in person_markers)


def _build_person_bio_image_reply(user_msg):
    query = _extract_person_query_text(user_msg) or str(user_msg or "").strip()
    if not query:
        return ""
    wiki_data = _fetch_wikipedia_summary_and_image(query)
    if not _is_person_wiki_entry(wiki_data):
        return ""
    summary = wiki_data.get("summary") or ""
    image_url = wiki_data.get("image") or ""
    if not summary:
        summary = _build_brief_topic_summary(query)
    lines = [f"{query}:", summary, ""]
    if image_url:
        lines.append(f"![{query}]({image_url})")
        lines.append(f"[Source](https://en.wikipedia.org/wiki/{quote(query.replace(' ', '_'))})")
    else:
        q = quote_plus(query)
        lines.append("I could not fetch a direct portrait right now. Here are quick links:")
        lines.append(f"[Google Images](https://www.google.com/search?tbm=isch&q={q})")
        lines.append(f"[Bing Images](https://www.bing.com/images/search?q={q})")
        lines.append(f"[Wikipedia](https://en.wikipedia.org/wiki/{quote(query.replace(' ', '_'))})")
    return "\n".join(lines).strip()


def _should_return_image_links(user_msg):
    msg = str(user_msg or "")
    if not msg.strip():
        return False
    return bool(IMAGE_REQUEST_PATTERN.search(msg) and LINK_REQUEST_PATTERN.search(msg))


def _should_return_image_gallery(user_msg):
    msg = str(user_msg or "")
    if not msg.strip():
        return False
    lower = msg.lower()
    if IMAGE_OF_REQUEST_PATTERN.search(lower):
        return True
    # Also treat short direct asks like "peacock pics", "taj mahal wallpaper"
    # as explicit gallery requests.
    if IMAGE_REQUEST_PATTERN.search(lower):
        return True
    return False


def _should_auto_image_with_brief(user_msg):
    msg = str(user_msg or "").strip()
    if not msg:
        return False
    lower = msg.lower()

    # Keep question/command prompts in normal AI flow.
    if re.search(r"\b(what|why|how|when|where|who|which|explain|write|code|summarize|summary|merge|combine|convert|extract|ocr|read text)\b", lower):
        return False

    # Explicit image ask should always trigger.
    if IMAGE_OF_REQUEST_PATTERN.search(lower) or IMAGE_REQUEST_PATTERN.search(lower):
        return True

    # Topic-name style queries (e.g. "taj mahal", "ferrari", "mango", "iphone 16")
    tokens = re.findall(r"[a-z0-9&'-]+", lower)
    if not tokens:
        return False
    if len(tokens) > 5:
        return False

    category_hints = {
        "fruit", "fruits", "car", "cars", "bike", "bikes", "motorcycle", "motorcycles",
        "place", "places", "city", "country", "monument", "temple", "fort", "palace",
        "phone", "laptop", "product", "products", "brand", "brands", "flower", "flowers"
    }
    if any(t in category_hints for t in tokens):
        return True

    # If it's a short noun-phrase style input, prefer image+brief mode.
    return len(tokens) <= 3


def _is_renderable_image_url(url):
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        return False
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (QyveraAI Image Validator)",
            "Accept": "image/*,*/*;q=0.8"
        }
        resp = requests.get(url, headers=headers, timeout=8, stream=True, allow_redirects=True)
        try:
            if resp.status_code != 200:
                return False
            ctype = (resp.headers.get("Content-Type") or "").lower()
            return ctype.startswith("image/")
        finally:
            resp.close()
    except Exception:
        return False


def _build_brief_topic_summary(query):
    # 1) Prefer Wikipedia short summary.
    try:
        wiki_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote(query)}"
        wiki_res = requests.get(wiki_url, timeout=8)
        if wiki_res.status_code == 200:
            data = wiki_res.json() or {}
            extract = (data.get("extract") or "").strip()
            if extract:
                short = re.sub(r"\s+", " ", extract)
                return short[:260].rstrip(". ") + "."
    except Exception:
        pass

    # 2) AI fallback (very short).
    try:
        ai_text = _call_groq_chat([
            {"role": "system", "content": "Write one short plain-text description in 1-2 sentences, maximum 35 words."},
            {"role": "user", "content": query}
        ]) or ""
        ai_text = re.sub(r"\s+", " ", ai_text).strip()
        if ai_text:
            return ai_text[:260].rstrip(". ") + "."
    except Exception:
        pass

    return f"{query} is a notable topic. Here are a few image references."


def _build_image_links_reply(user_msg):
    query = _extract_image_query_text(user_msg)
    q = quote_plus(query)
    query_slug = query.replace(" ", "-").strip("-")
    brief = _build_brief_topic_summary(query)
    # Prefer search-result thumbnails with relevance ranking (instead of random feeds).
    def _tokens(text):
        raw = re.findall(r"[a-z0-9]+", str(text or "").lower())
        stop = {
            "image", "images", "photo", "photos", "picture", "pictures",
            "of", "for", "the", "a", "an", "and", "with", "in", "on"
        }
        return [t for t in raw if t not in stop]

    query_tokens = _tokens(query)

    def _score_text_blob(blob):
        blob_tokens = set(_tokens(blob))
        if not query_tokens:
            return 0, 0.0
        score = 0
        matches = 0
        for t in query_tokens:
            if t in blob_tokens:
                score += 3
                matches += 1
            elif any(bt.startswith(t) or t.startswith(bt) for bt in blob_tokens):
                score += 1
                matches += 1
        ratio = matches / max(1, len(query_tokens))
        return score, ratio

    candidates = []

    try:
        # Openverse: broader coverage
        ov_resp = requests.get(
            "https://api.openverse.org/v1/images/",
            params={"q": query, "page_size": 20},
            timeout=12
        )
        if ov_resp.status_code == 200:
            ov_data = ov_resp.json() or {}
            for item in (ov_data.get("results") or []):
                thumb = item.get("thumbnail") or item.get("url")
                source = item.get("foreign_landing_url") or item.get("url")
                title = item.get("title") or ""
                tags = " ".join(tag.get("name", "") for tag in (item.get("tags") or []) if isinstance(tag, dict))
                if not thumb or not source:
                    continue
                blob = f"{title} {tags}"
                score, ratio = _score_text_blob(blob)
                candidates.append({
                    "thumb": thumb,
                    "source": source,
                    "score": score,
                    "ratio": ratio
                })
    except Exception:
        pass

    try:
        # Wikimedia Commons: often better for historic places/people.
        wm_resp = requests.get(
            "https://commons.wikimedia.org/w/api.php",
            params={
                "action": "query",
                "generator": "search",
                "gsrsearch": query,
                "gsrnamespace": 6,
                "gsrlimit": 20,
                "prop": "imageinfo",
                "iiprop": "url",
                "iiurlwidth": 900,
                "format": "json"
            },
            timeout=12
        )
        if wm_resp.status_code == 200:
            wm_data = wm_resp.json() or {}
            pages = (wm_data.get("query") or {}).get("pages") or {}
            for page in pages.values():
                title = str(page.get("title") or "")
                info = ((page.get("imageinfo") or [{}])[0]) if page.get("imageinfo") else {}
                thumb = info.get("thumburl") or info.get("url")
                source = f"https://commons.wikimedia.org/wiki/{quote_plus(title)}" if title else info.get("descriptionurl")
                if not thumb or not source:
                    continue
                # slight preference for Wikimedia if score ties.
                score, ratio = _score_text_blob(title)
                candidates.append({
                    "thumb": thumb,
                    "source": source,
                    "score": score + 1,
                    "ratio": ratio
                })
    except Exception:
        pass

    # De-duplicate by thumbnail URL and pick highest-scoring matches.
    best_by_thumb = {}
    for c in candidates:
        key = c["thumb"]
        prev = best_by_thumb.get(key)
        if prev is None or c["score"] > prev["score"]:
            best_by_thumb[key] = c

    ranked = sorted(best_by_thumb.values(), key=lambda x: (x.get("score", 0), x.get("ratio", 0.0)), reverse=True)
    # Keep only relevant and renderable matches; avoid random/broken results.
    top = []
    for item in ranked:
        if item.get("score", 0) <= 0:
            continue
        if item.get("ratio", 0.0) < (0.50 if len(query_tokens) >= 2 else 0.25):
            continue
        if not _is_renderable_image_url(item.get("thumb", "")):
            continue
        top.append(item)
        if len(top) == 4:
            break

    if top:
        lines = [f"Here are images for {query}.", f"Brief: {brief}", ""]
        for idx, item in enumerate(top, start=1):
            lines.append(f"![{query} {idx}]({item['thumb']})")
            lines.append(f"[Source]({item['source']})")
            lines.append("")
        lines.append("More links:")
        lines.append(f"[Google Images](https://www.google.com/search?tbm=isch&q={q})")
        lines.append(f"[Bing Images](https://www.bing.com/images/search?q={q})")
        lines.append(f"[Wikimedia Commons](https://commons.wikimedia.org/w/index.php?search={q}&title=Special:MediaSearch&go=Go&type=image)")
        return "\n".join(lines).strip()
    if _is_person_like_query(query):
        refine_hint = f"Try a more specific prompt (for example: '{query} portrait', '{query} official photo')."
    else:
        refine_hint = f"Try a more specific prompt (for example: '{query} high-resolution photo', '{query} official image')."
    return (
        f"I could not find sufficiently relevant direct image previews for {query}.\n"
        f"Brief: {brief}\n\n"
        f"{refine_hint}\n"
        f"[Google Images](https://www.google.com/search?tbm=isch&q={q})\n"
        f"[Bing Images](https://www.bing.com/images/search?q={q})\n"
        f"[Wikimedia Commons](https://commons.wikimedia.org/w/index.php?search={q}&title=Special:MediaSearch&go=Go&type=image)"
    )


def _image_provider_urls(query, seed):
    q = quote_plus(query)
    # Disabled random providers like Flickr / Unsplash to avoid unrelated images.
    # Image results will now come from structured sources (Wikimedia / Openverse)
    # and Google Images links instead of random generators.
    return []


def _extract_pdf_text_for_summary(pdf_path, max_pages=4, max_chars=6000):
    if PdfReader is None or not pdf_path or not os.path.exists(pdf_path):
        return ""
    try:
        reader = PdfReader(pdf_path)
        chunks = []
        total = 0
        for page in reader.pages[:max_pages]:
            page_text = page.extract_text() or ""
            if not page_text.strip():
                continue
            remain = max_chars - total
            if remain <= 0:
                break
            page_text = page_text[:remain]
            chunks.append(page_text)
            total += len(page_text)
            if total >= max_chars:
                break
        return "\n".join(chunks).strip()
    except Exception:
        return ""


def _extract_text_from_image_path(image_path, max_chars=12000):
    if not image_path or not os.path.exists(image_path):
        return ""
    if Image is None or pytesseract is None:
        return ""
    try:
        with Image.open(image_path) as img:
            processed = _preprocess_image_for_ocr(img)
            text = pytesseract.image_to_string(processed, config="--oem 3 --psm 6") or ""
        return text[:max_chars].strip()
    except Exception:
        return ""


def _preprocess_image_for_ocr(img):
    if Image is None:
        return img
    # 1) Grayscale
    processed = img.convert("L")

    # 2) Increase contrast
    if ImageEnhance is not None:
        processed = ImageEnhance.Contrast(processed).enhance(1.9)

    # 3) Sharpen
    if ImageFilter is not None:
        processed = processed.filter(ImageFilter.SHARPEN)

    # 4) Binary threshold
    processed = processed.point(lambda p: 255 if p > 155 else 0, mode="1").convert("L")

    # 5) Remove small noise (median filter)
    if ImageFilter is not None:
        processed = processed.filter(ImageFilter.MedianFilter(size=3))

    return processed


def _extract_text_from_pdf_with_ocr(pdf_path, max_pages=4, max_chars=12000):
    if not pdf_path or not os.path.exists(pdf_path):
        return ""

    # 1) Try native PDF text extraction first.
    direct = _extract_pdf_text_for_summary(pdf_path, max_pages=max_pages, max_chars=max_chars)
    if direct:
        return direct[:max_chars].strip()

    # 2) Scanned PDF fallback: render pages as images + OCR.
    if convert_from_path is None or pytesseract is None:
        return ""
    try:
        images = convert_from_path(pdf_path, first_page=1, last_page=max_pages)
        chunks = []
        total = 0
        for img in images:
            processed = _preprocess_image_for_ocr(img)
            page_text = (pytesseract.image_to_string(processed, config="--oem 3 --psm 6") or "").strip()
            if not page_text:
                continue
            remain = max_chars - total
            if remain <= 0:
                break
            page_text = page_text[:remain]
            chunks.append(page_text)
            total += len(page_text)
            if total >= max_chars:
                break
        return "\n\n".join(chunks).strip()
    except Exception:
        return ""


def _extract_direct_text_for_summary(user_msg):
    if not user_msg:
        return ""
    text = re.sub(r"\bsummarize\b", " ", str(user_msg), flags=re.IGNORECASE)
    text = re.sub(r"\b(this|it|text|content)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"^[\s:,\-]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _save_ai_reply(user_id, conversation_id, reply_text, download_url=None, download_file_name="merged.pdf", download_file_mime="application/pdf"):
    conn = sqlite3.connect("chat.db")
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO messages (user_id, conversation_id, role, content) VALUES (?, ?, ?, ?)",
        (user_id, conversation_id, "assistant", reply_text)
    )
    ai_message_id = cur.lastrowid
    if download_url:
        cur.execute(
            """
            INSERT INTO message_attachments
            (user_id, conversation_id, message_id, role, file_name, file_path, file_mime, is_download)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (
                user_id,
                conversation_id,
                ai_message_id,
                "assistant",
                download_file_name,
                download_url,
                download_file_mime
            )
        )
    conn.commit()
    conn.close()


# ================= CHAT MEMORY =================
chat_history = []  # kept (not used anymore, safe to keep)

SYSTEM_PROMPT = (
"You are Qyvera AI, a helpful assistant.\n"
"Rules:\n"
"1. Always answer the user's question directly, clearly, and with enough detail to be genuinely useful.\n"
"2. Use simple explanations that are easy to understand.\n"
"2a. Understand the user's intended meaning even when the message has spelling mistakes, broken grammar, missing words, shorthand, or informal phrasing.\n"
"2b. Infer the most likely intent from context like ChatGPT would, instead of focusing too literally on small wording mistakes.\n"
"2c. If the user's wording is imperfect but the likely meaning is clear, answer helpfully without asking for correction.\n"
"2d. Only ask a clarifying question when the request is genuinely ambiguous and multiple meanings would change the answer.\n"
"2e. Do not criticize the user's grammar, spelling, or wording unless the user explicitly asks for correction.\n"
"3. Only use a comparison table when the user explicitly asks for a comparison, difference, diff, differentiate, versus, vs, or compare between two or more things.\n"
"4. The comparison must be formatted as a clean table with clear column headers and rows.\n"
"5. The comparison table must visually resemble ChatGPT-style comparison tables.\n"
"6. After the comparison table, add a short plain-language explanation or takeaway paragraph.\n"
"7. The response must begin directly with the table when a comparison is requested.\n"
"8. Tables must contain a header row followed by multiple comparison rows.\n"
"9. Table columns must be aligned and clearly separated so they render as a proper table.\n"
"10. For comparison requests, the very first character of the response must be the start of the table header row.\n"
"11. Do not output any introductory sentences, explanations, or text before the table when a comparison is requested.\n"
"11a. For greetings and normal conversation such as hi, hello, hey, how are you, or general questions, never use a table.\n"
"11b. For non-comparison requests, respond with normal conversational text only.\n"
"12. When writing code, always preserve required comment symbols exactly such as # in Python.\n"
"13. Never remove or alter comment characters in any programming language.\n"
"14. Always write code inside fenced code blocks.\n"
"15. Always include the correct language label such as python, javascript, html, css, or c.\n"
"16. Proper fenced code blocks must be used so syntax highlighting and code colors render correctly.\n"
"17. When the user requests images, photos, pictures, pics, or wallpapers, always provide multiple real images.\n"
"18. Each image must include a direct public image URL.\n"
"19. Each image must include a clickable source link.\n"
"20. Never return internal proxy URLs, local server paths, or private endpoints for images.\n"
"21. Only use real external image URLs from public sources.\n"
"22. Always include clickable source links when providing external references or images.\n"
"23. Never say that the AI service is unavailable.\n"
"24. Never mention system errors, backend issues, internal APIs, or infrastructure problems.\n"
"25. Never tell the user to refresh the page, reload, try again later, or check back later.\n"
"26. Always produce clean, structured, readable output.\n"
"27. If a comparison is requested, the output must immediately start with a properly formatted table.\n"
"28. The table must contain column headers, rows, and a clear comparison structure.\n"
"29. Do not write explanations before the table when the user asks for differences; any explanation must come after the table.\n"
"30. For explanations, summaries, normal question-answer responses, and content writing, prefer fuller and more helpful answers instead of overly short replies.\n"
"30a. If the user says briefly, short, or concise, still give a useful compact explanation with enough substance to understand the topic well.\n"
"30b. Brief answers should usually still include a short definition, 2 to 4 key points or steps, and a short concluding line when relevant.\n"
"30c. Do not reduce brief explanations to only 4 or 5 thin lines unless the user explicitly asks for one-line, two-line, or very short answers.\n"
"31. For short conversational replies such as hi, hello, how are you, all good, or other simple questions, answer in plain text without headings, bold text, tables, or horizontal rules.\n"
"32. For longer non-code, non-table answers, use markdown only when it improves readability, such as headings, subheadings, bullets, or numbered lists.\n"
"33. Use bold text only for true headings or subheadings, never for a full sentence, greeting, or normal conversational reply.\n"
"34. When an answer has multiple major sections, separate only those major sections with a markdown horizontal rule written as --- on its own line.\n"
"35. Do not return a single dense paragraph when a structured answer would be clearer.\n"
"36. Follow all formatting and structure rules strictly.\n"
)

# ================= HOME =================
@app.route("/")
def home():
    return render_template("index.html")


# ================= GOOGLE LOGIN =================
@app.route("/login/google")
def google_login():
    google_provider_cfg = requests.get(env("GOOGLE_DISCOVERY_URL")).json()
    authorization_endpoint = google_provider_cfg["authorization_endpoint"]

    request_uri = authorization_endpoint + "?" + urlencode({
        "client_id": os.getenv("GOOGLE_CLIENT_ID"),
        "redirect_uri": os.getenv("GOOGLE_REDIRECT_URI"),
        "scope": "openid email profile",
        "response_type": "code",
        "prompt": "select_account"
    })

    return redirect(request_uri)


@app.route("/google-callback")
def google_callback():
    code = request.args.get("code")

    google_provider_cfg = requests.get(env("GOOGLE_DISCOVERY_URL")).json()
    token_endpoint = google_provider_cfg["token_endpoint"]

    token_response = requests.post(
        token_endpoint,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=urlencode({
            "client_id": os.getenv("GOOGLE_CLIENT_ID"),
            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": os.getenv("GOOGLE_REDIRECT_URI"),
        })
    ).json()

    userinfo_endpoint = google_provider_cfg["userinfo_endpoint"]

    userinfo_response = requests.get(
        userinfo_endpoint,
        headers={"Authorization": f"Bearer {token_response['access_token']}"}
    ).json()

    # save login session
    session["user_id"] = userinfo_response["sub"]
    session["username"] = userinfo_response["email"]
    session["user_picture"] = userinfo_response.get("picture")
    session["fresh_login"] = True

    return redirect("/")


# ================= AUTH CHECK =================
@app.route("/auth-check")
def auth_check():
    if "user_id" not in session:
        return jsonify({"logged_in": False}), 401

    return jsonify({
        "logged_in": True,
        "email": session.get("username"),
        "picture": session.get("user_picture"),
        "fresh_login": session.pop("fresh_login", False)
    }), 200

@app.route("/clear-history", methods=["POST"])
def clear_history():
    user_id = session.get("user_id")

    conn = sqlite3.connect("chat.db")
    cur = conn.cursor()
    cur.execute(
        "SELECT file_path FROM message_attachments WHERE user_id=? AND is_download=0",
        (user_id,)
    )
    file_rows = cur.fetchall()
    for (path,) in file_rows:
        _remove_attachment_file_if_exists(path)
    cur.execute("DELETE FROM message_attachments WHERE user_id=?", (user_id,))
    cur.execute("DELETE FROM messages WHERE user_id=?", (user_id,))
    conn.commit()
    conn.close()

    for key in list(CONVERSATION_UPLOADS.keys()):
        if key[0] == user_id:
            CONVERSATION_UPLOADS.pop(key, None)

    return jsonify({"status":"all_deleted"})


# ================= CHAT =================
@app.route("/chat", methods=["POST"])
def chat():
    if "user_id" not in session:
        return jsonify({"error": "Unauthorized"}), 401
    user_id = session["user_id"]

    is_multipart = "multipart/form-data" in (request.content_type or "")
    if is_multipart:
        user_msg = (request.form.get("message") or "").strip()
        conversation_id = request.form.get("conversation_id")
        uploaded_files = request.files.getlist("files")
    else:
        payload = request.get_json(silent=True) or {}
        user_msg = (payload.get("message") or "").strip()
        conversation_id = payload.get("conversation_id")
        uploaded_files = []

    if not isinstance(user_msg, str):
        user_msg = ""
    if not conversation_id:
        return jsonify({"reply": "Missing conversation_id"}), 400

    saved_file_names = []
    saved_uploads = []
    conv_safe = secure_filename(str(conversation_id))
    user_safe = secure_filename(str(user_id))
    conversation_upload_dir = os.path.join(TEMP_UPLOAD_DIR, f"{user_safe}_{conv_safe}")
    os.makedirs(conversation_upload_dir, exist_ok=True)
    for file_obj in uploaded_files:
        if not file_obj or not file_obj.filename:
            continue
        safe_name = os.path.basename(file_obj.filename)
        if not safe_name:
            continue
        ext = (safe_name.rsplit(".", 1)[-1] if "." in safe_name else "").lower()
        mime = (file_obj.mimetype or "").lower()
        if ext not in ALLOWED_UPLOAD_EXT and mime not in ALLOWED_UPLOAD_MIME:
            return jsonify({"reply": f"Unsupported file type: {safe_name}"}), 400

        # Save every uploaded file to temp storage so future tools can reuse it.
        # Keep original filename as requested.
        temp_path = os.path.join(conversation_upload_dir, safe_name)
        file_obj.stream.seek(0)
        file_obj.save(temp_path)

        saved_file_names.append(safe_name)
        saved_uploads.append({
            "name": safe_name,
            "ext": ext,
            "mime": mime,
            "path": temp_path
        })

    # Keep a cumulative working set per conversation (upload -> upload -> merge).
    conv_key = (user_id, conversation_id)
    existing_uploads = CONVERSATION_UPLOADS.get(conv_key, [])
    if saved_uploads:
        existing_uploads.extend(saved_uploads)
        if len(existing_uploads) > MAX_UPLOADS_PER_CONVERSATION:
            stale = existing_uploads[:-MAX_UPLOADS_PER_CONVERSATION]
            for item in stale:
                try:
                    if os.path.exists(item["path"]):
                        os.remove(item["path"])
                except Exception:
                    pass
            existing_uploads = existing_uploads[-MAX_UPLOADS_PER_CONVERSATION:]
        CONVERSATION_UPLOADS[conv_key] = existing_uploads

    if not user_msg and not saved_file_names:
        return jsonify({"reply": "Empty message"}), 400

    normalized_user_msg = _normalize_user_message_for_ai(user_msg)

    # Keep message text clean; attachment metadata is stored separately.
    stored_user_msg = user_msg

    try:
        download_url = None
        reply = ""
        download_file_name = "merged.pdf"
        download_file_mime = "application/pdf"
        # ---------- SAVE USER MESSAGE ----------
        conn = sqlite3.connect("chat.db")
        cur = conn.cursor()

        cur.execute(
            "INSERT INTO messages (user_id, conversation_id, role, content) VALUES (?, ?, ?, ?)",
            (user_id, conversation_id, "user", stored_user_msg)
        )
        user_message_id = cur.lastrowid

        for file_info in saved_uploads:
            cur.execute(
                """
                INSERT INTO message_attachments
                (user_id, conversation_id, message_id, role, file_name, file_path, file_mime, is_download)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    user_id,
                    conversation_id,
                    user_message_id,
                    "user",
                    file_info["name"],
                    file_info["path"],
                    file_info["mime"]
                )
            )
        conn.commit()

        # ---------- LOAD LAST 10 MESSAGES ----------
        cur.execute("""
            SELECT role, content FROM messages
            WHERE user_id = ? AND conversation_id = ?
            ORDER BY id DESC
            LIMIT 5
            """, (user_id, conversation_id))

        rows = cur.fetchall()
        conn.close()

        # ensure chronological order
        rows = rows[::-1]

        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for r, c in rows:
            if not c:
                continue
            role = str(r).strip().lower()
            if role not in ["user", "assistant", "system"]:
                continue
            messages.append({"role": role, "content": str(c).strip()})

        # fallback (very first message edge case)
        if len(messages) == 1:
            messages.append({"role": "user", "content": normalized_user_msg})

        clean_messages = []
        for m in messages:
            if not isinstance(m, dict):
                continue

            role = str(m.get("role", "")).strip()
            content = str(m.get("content", "")).strip()

            if not role or not content:
                continue

            clean_messages.append({
            "role": role,
            "content": content[:2000]
            })

        # ---------- TOOL: MERGE PDF ----------
        lower_msg = (user_msg or "").lower()
        routed_tool, target_format = _route_tool_intent(lower_msg)
        wants_pdf_merge = routed_tool == "pdf_merge"
        wants_pdf_summary = routed_tool == "summarize"
        wants_text_extract = routed_tool == "ocr"
        wants_image_convert = routed_tool == "image_convert"

        if wants_pdf_merge:
            if PdfMerger is None:
                reply = "PDF merge tool is unavailable. Please install PyPDF2 or pypdf on the server."
            else:
                # Use all stored PDFs in the current conversation working set.
                latest_batch = CONVERSATION_UPLOADS.get(conv_key, [])
                pdf_uploads = [
                    {"path": item.get("path", "")}
                    for item in latest_batch
                    if item.get("ext") == "pdf" and os.path.exists(item.get("path", ""))
                ]

                # De-duplicate by absolute path.
                seen = set()
                unique_pdf_uploads = []
                for item in pdf_uploads:
                    norm = os.path.abspath(item["path"])
                    if norm in seen:
                        continue
                    seen.add(norm)
                    unique_pdf_uploads.append(item)
                pdf_uploads = unique_pdf_uploads

                if len(pdf_uploads) == 1:
                    reply = "You need at least two PDFs to merge. Please upload another."
                elif len(pdf_uploads) < 1:
                    reply = "I couldn't find PDFs in this conversation. Please upload PDF files first."
                else:
                    merger = PdfMerger()
                    try:
                        for item in pdf_uploads:
                            merger.append(item["path"])

                        merged_name = f"merged_{uuid.uuid4().hex[:12]}.pdf"
                        merged_path = os.path.join(MERGED_DIR, merged_name)
                        with open(merged_path, "wb") as f:
                            merger.write(f)
                        merger.close()

                        MERGED_FILE_OWNERS[merged_name] = user_id
                        download_url = f"/download/merged/{merged_name}"
                        reply = "Your merged PDF is ready."
                        # Clear stored PDFs only after successful merge; keep non-PDF files.
                        CONVERSATION_UPLOADS[conv_key] = [
                            item for item in latest_batch
                            if item.get("ext") != "pdf"
                        ]
                    finally:
                        pass
        elif wants_pdf_summary:
            latest_batch = CONVERSATION_UPLOADS.get(conv_key, [])
            latest_pdf = None
            latest_image = None
            for item in reversed(latest_batch):
                if item.get("ext") == "pdf" and os.path.exists(item.get("path", "")):
                    latest_pdf = item
                    break
            if latest_pdf is None:
                for item in reversed(latest_batch):
                    if item.get("ext") in {"png", "jpg", "jpeg", "webp"} and os.path.exists(item.get("path", "")):
                        latest_image = item
                        break

            extracted = ""
            if latest_pdf:
                extracted = _extract_pdf_text_for_summary(latest_pdf.get("path", ""))
                if not extracted:
                    extracted = _extract_text_from_pdf_with_ocr(latest_pdf.get("path", ""))
            elif latest_image:
                extracted = _extract_text_from_image_path(latest_image.get("path", ""))
            else:
                direct_text = _extract_direct_text_for_summary(user_msg)
                if direct_text and len(direct_text) <= 200:
                    reply = "Text is too short to summarize."
                elif direct_text and len(direct_text) > 200:
                    extracted = direct_text
                else:
                    reply = "Please upload a PDF, image, or provide text to summarize."

            if not reply:
                if not extracted or len(extracted.strip()) <= 200:
                    reply = "Text is too short to summarize."
                else:
                    try:
                        summary_messages = [
                            {
                                "role": "system",
                                "content": (
                                    "Summarize the given text clearly and concisely. "
                                    "Use short bullet points and a brief conclusion."
                                )
                            },
                            {"role": "user", "content": extracted[:12000]}
                        ]
                        summary_text = (_call_groq_chat(summary_messages) or "").strip()
                        if not summary_text:
                            summary_text = "I couldn't generate a summary for that document."
                    except Exception:
                        summary_text = "I couldn't generate a summary for that document."
                    summary_text = _clean_ai_plain_text(summary_text)
                    reply = f"Summary:\n{summary_text}"
        elif wants_text_extract:
            latest_batch = CONVERSATION_UPLOADS.get(conv_key, [])
            latest_supported = None
            for item in reversed(latest_batch):
                if item.get("ext") in {"pdf", "png", "jpg", "jpeg"} and os.path.exists(item.get("path", "")):
                    latest_supported = item
                    break

            if not latest_supported:
                reply = "Please upload a file to extract text from."
            else:
                ext = latest_supported.get("ext")
                file_path = latest_supported.get("path", "")
                extracted_text = ""

                if ext in {"png", "jpg", "jpeg"}:
                    extracted_text = _extract_text_from_image_path(file_path)
                elif ext == "pdf":
                    extracted_text = _extract_text_from_pdf_with_ocr(file_path)

                if not extracted_text:
                    extracted_text = "No readable text detected."
                reply = f"Extracted Text:\n\n{extracted_text}"
        elif wants_image_convert:
            latest_batch = CONVERSATION_UPLOADS.get(conv_key, [])
            latest_image = None
            for item in reversed(latest_batch):
                if item.get("ext") in {"png", "jpg", "jpeg", "webp"} and os.path.exists(item.get("path", "")):
                    latest_image = item
                    break

            if not latest_image:
                reply = "Please upload an image to convert."
            elif target_format not in {"png", "jpg", "webp", "pdf"}:
                reply = "Which format would you like to convert to? (png, jpg, webp, pdf)"
            elif Image is None:
                reply = "Image converter is unavailable. Please install Pillow on the server."
            else:
                source_path = latest_image.get("path")
                out_ext = "jpg" if target_format == "jpg" else target_format
                out_name = f"converted_{uuid.uuid4().hex[:12]}.{out_ext}"
                out_path = os.path.join(MERGED_DIR, out_name)
                try:
                    with Image.open(source_path) as img:
                        mode = img.mode or "RGB"
                        if target_format in {"jpg", "pdf"} and mode in {"RGBA", "LA", "P"}:
                            img = img.convert("RGB")
                        elif target_format in {"png", "webp"} and mode not in {"RGB", "RGBA"}:
                            img = img.convert("RGBA")

                        if target_format == "jpg":
                            img.save(out_path, format="JPEG")
                            download_file_mime = "image/jpeg"
                        elif target_format == "png":
                            img.save(out_path, format="PNG")
                            download_file_mime = "image/png"
                        elif target_format == "webp":
                            img.save(out_path, format="WEBP")
                            download_file_mime = "image/webp"
                        else:
                            img.save(out_path, format="PDF")
                            download_file_mime = "application/pdf"

                    CONVERTED_FILE_OWNERS[out_name] = user_id
                    download_url = f"/download/converted/{out_name}"
                    download_file_name = out_name
                    reply = "Your converted file is ready."
                except Exception:
                    reply = "I couldn't convert that image. Please try another image or format."
        else:
            # ---------- STREAMING AI (non-tool path only) ----------
            static_reply = None
            if saved_file_names:
                uploaded_has_pdf = any(item.get("ext") == "pdf" for item in saved_uploads)
                uploaded_has_image = any(item.get("ext") in {"png", "jpg", "jpeg", "webp"} for item in saved_uploads)
                if uploaded_has_pdf and not user_msg:
                    static_reply = "I received your PDF.\nWhat would you like to do with it?"
                elif uploaded_has_image and not user_msg:
                    static_reply = "I received your image. What would you like to do with it?"
                else:
                    static_reply = "I received your files. What would you like to do with them?"
            else:
                person_reply = _build_person_bio_image_reply(user_msg)
                if person_reply:
                    static_reply = person_reply
            if static_reply is None and (_should_return_image_gallery(user_msg) or _should_return_image_links(user_msg)):
                static_reply = _build_image_links_reply(user_msg)
            if static_reply is None and _is_simple_greeting(user_msg):
                static_reply = "Hello! How can I help you today?"

            def stream_ai_chunks():
                final_parts = []
                fallback = "I couldn't generate a response for that request."
                try:
                    if static_reply is not None:
                        cleaned_static = _clean_ai_plain_text(static_reply)
                        # Stream static/tool-style text progressively (word chunks)
                        # so image markdown appears progressively instead of one dump.
                        chunks = re.split(r"(\s+)", cleaned_static)
                        for part in chunks:
                            if not part:
                                continue
                            final_parts.append(part)
                            yield part
                            # Small pacing so frontend receives visible streaming steps.
                            if part.strip():
                                time.sleep(0.012)
                        return

                    if clean_messages:
                        ai_messages = clean_messages[:-1] + [
                            {
                                "role": clean_messages[-1]["role"],
                                "content": normalized_user_msg if clean_messages[-1]["role"] == "user" else clean_messages[-1]["content"]
                            }
                        ]
                    else:
                        ai_messages = [{"role": "user", "content": normalized_user_msg or ""}]
                    seen_any = False
                    raw_accumulated = ""
                    emitted_clean = ""
                    # Detect comparison requests to enforce table-first streaming
                    is_comparison_request = _is_comparison_request(user_msg)
                    stream = _stream_groq_chat(ai_messages)
                    if not stream:
                        raise RuntimeError("Groq streaming unavailable")
                    for token in stream:
                        seen_any = True
                        raw_accumulated += token
                        cleaned_full = _clean_ai_plain_text(raw_accumulated)
                        if not is_comparison_request:
                            cleaned_full = re.sub(r"^\s*(\d+)\.\s*[-:]\s*$", "", cleaned_full, flags=re.MULTILINE)
                            cleaned_full = re.sub(r"\n{3,}", "\n\n", cleaned_full)

                        if len(cleaned_full) < len(emitted_clean):
                            emitted_clean = cleaned_full
                            continue

                        delta = cleaned_full[len(emitted_clean):]

                        if delta:
                            emitted_clean = cleaned_full
                            final_parts.append(delta)
                            yield delta
                    if not seen_any:
                        raise RuntimeError("Empty AI stream")
                except Exception:
                    final_parts = [fallback]
                    yield fallback
                finally:
                    final_reply = "".join(final_parts).strip()
                    if not final_reply:
                        final_reply = fallback
                    _save_ai_reply(user_id, conversation_id, final_reply)

            return Response(
                stream_with_context(stream_ai_chunks()),
                mimetype="text/plain; charset=utf-8",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
            )

        # ---------- SAVE AI REPLY ----------
        _save_ai_reply(user_id, conversation_id, reply, download_url, download_file_name, download_file_mime)

        payload = {"reply": reply}
        if download_url:
            payload["download_url"] = download_url
        return jsonify(payload)

    except Exception as e:
        return jsonify({"reply": "Error: " + str(e)})


@app.route("/download/merged/<filename>", methods=["GET"])
def download_merged_pdf(filename):
    if "user_id" not in session:
        return jsonify({"error": "Unauthorized"}), 401

    safe_name = secure_filename(filename)
    owner = MERGED_FILE_OWNERS.get(safe_name)
    if owner != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403

    full_path = os.path.join(MERGED_DIR, safe_name)
    if not os.path.exists(full_path):
        return jsonify({"error": "File not found"}), 404

    return send_from_directory(MERGED_DIR, safe_name, as_attachment=True, download_name="merged.pdf")


@app.route("/download/converted/<filename>", methods=["GET"])
def download_converted_file(filename):
    if "user_id" not in session:
        return jsonify({"error": "Unauthorized"}), 401

    safe_name = secure_filename(filename)
    owner = CONVERTED_FILE_OWNERS.get(safe_name)
    if owner != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403

    full_path = os.path.join(MERGED_DIR, safe_name)
    if not os.path.exists(full_path):
        return jsonify({"error": "File not found"}), 404

    return send_from_directory(MERGED_DIR, safe_name, as_attachment=True, download_name=safe_name)


@app.route("/uploads/<int:attachment_id>", methods=["GET"])
def open_uploaded_file(attachment_id):
    if "user_id" not in session:
        return jsonify({"error": "Unauthorized"}), 401

    user_id = session["user_id"]
    conn = sqlite3.connect("chat.db")
    cur = conn.cursor()
    cur.execute(
        """
        SELECT file_name, file_path, file_mime
        FROM message_attachments
        WHERE id = ? AND user_id = ? AND is_download = 0
        """,
        (attachment_id, user_id)
    )
    row = cur.fetchone()
    conn.close()

    if not row:
        return jsonify({"error": "File not found"}), 404

    file_name, file_path, file_mime = row
    if not file_path or not os.path.exists(file_path):
        return jsonify({"error": "File missing on server"}), 404

    file_dir = os.path.dirname(file_path)
    safe_name = os.path.basename(file_path)
    return send_from_directory(file_dir, safe_name, mimetype=file_mime, as_attachment=False)


@app.route("/image-proxy", methods=["GET"])
def image_proxy():
    query = (request.args.get("q") or "").strip()
    seed = (request.args.get("seed") or "1").strip()
    if not query:
        return jsonify({"error": "Missing query"}), 400

    try:
        seed_int = int(seed)
    except Exception:
        seed_int = 1

    headers = {
        "User-Agent": "Mozilla/5.0 (QyveraAI Image Proxy)",
        "Accept": "image/*,*/*;q=0.8"
    }

    for url in _image_provider_urls(query, seed_int):
        try:
            resp = requests.get(url, headers=headers, timeout=15, allow_redirects=True)
            if resp.status_code != 200:
                continue
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if not ctype.startswith("image/"):
                continue
            return Response(
                resp.content,
                mimetype=ctype,
                headers={
                    "Cache-Control": "public, max-age=600",
                    "Access-Control-Allow-Origin": "*"
                }
            )
        except Exception:
            continue

    return jsonify({"error": "Image unavailable"}), 502


@app.route("/image-proxy-url", methods=["GET"])
def image_proxy_url():
    src = (request.args.get("src") or "").strip()
    if not src.lower().startswith(("http://", "https://")):
        return jsonify({"error": "Invalid src"}), 400

    headers = {
        "User-Agent": "Mozilla/5.0 (QyveraAI External Image Proxy)",
        "Accept": "image/*,*/*;q=0.8",
        "Referer": "https://www.google.com/"
    }
    try:
        resp = requests.get(src, headers=headers, timeout=15, allow_redirects=True)
        if resp.status_code != 200:
            return jsonify({"error": "Image unavailable"}), 502
        ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if not ctype.startswith("image/"):
            return jsonify({"error": "Not an image"}), 502
        return Response(
            resp.content,
            mimetype=ctype,
            headers={
                "Cache-Control": "public, max-age=600",
                "Access-Control-Allow-Origin": "*"
            }
        )
    except Exception:
        return jsonify({"error": "Image unavailable"}), 502


@app.route("/delete-session", methods=["POST"])
def delete_session():
    user_id = session.get("user_id")
    data = request.json
    conversation_id = data.get("conversation_id")

    conn = sqlite3.connect("chat.db")
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM messages WHERE user_id=? AND conversation_id=?",
        (user_id, conversation_id)
    )
    cur.execute(
        """
        SELECT file_path
        FROM message_attachments
        WHERE user_id=? AND conversation_id=? AND is_download=0
        """,
        (user_id, conversation_id)
    )
    file_rows = cur.fetchall()
    for (path,) in file_rows:
        _remove_attachment_file_if_exists(path)
    cur.execute(
        "DELETE FROM message_attachments WHERE user_id=? AND conversation_id=?",
        (user_id, conversation_id)
    )
    conn.commit()
    conn.close()

    CONVERSATION_UPLOADS.pop((user_id, conversation_id), None)

    return jsonify({"status":"deleted"})

# ================= LOAD HISTORY =================
@app.route("/history")
def history():
    if "user_id" not in session:
        return jsonify({"chats": {}})

    user_id = session["user_id"]

    conn = sqlite3.connect("chat.db")
    cur = conn.cursor()

    # get chats ordered by latest message id
    cur.execute("""
        SELECT id, conversation_id, role, content
        FROM messages
        WHERE user_id = ?
        ORDER BY id ASC
    """, (user_id,))
    rows = cur.fetchall()

    cur.execute("""
        SELECT id, message_id, role, file_name, file_path, is_download
        FROM message_attachments
        WHERE user_id = ?
        ORDER BY id ASC
    """, (user_id,))
    attachment_rows = cur.fetchall()

    # NEW: get order of conversations by last message
    cur.execute("""
        SELECT conversation_id, MAX(id) as last_msg
        FROM messages
        WHERE user_id = ?
        GROUP BY conversation_id
        ORDER BY last_msg DESC
    """, (user_id,))
    order_rows = cur.fetchall()

    conn.close()

    attachments_by_message = {}
    for attach_id, message_id, role, file_name, file_path, is_download in attachment_rows:
        attachments_by_message.setdefault(message_id, [])
        if is_download:
            attachments_by_message[message_id].append({
                "name": "Download File",
                "url": file_path,
                "kind": "download"
            })
        else:
            attachments_by_message[message_id].append({
                "name": file_name,
                "url": f"/uploads/{attach_id}",
                "kind": "file"
            })

    chats = {}
    for msg_id, conv_id, role, content in rows:
        message_payload = {
            "role": role,
            "content": content or "",
            "attachments": attachments_by_message.get(msg_id, [])
        }
        chats.setdefault(conv_id, []).append(message_payload)

    # send order separately
    order = [conv_id for conv_id, _ in order_rows]

    return jsonify({
        "chats": chats,
        "order": order
    })

# ================= LOGOUT =================
@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"success": True})


# ================= RUN =================
if __name__ == "__main__":
    app.run(debug=True, port=5001)
