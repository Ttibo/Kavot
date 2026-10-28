"""Scheduled, local article discovery using the configured OpenAlex source."""
from __future__ import annotations

import re
import threading
import time
import unicodedata
from collections import Counter
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit

from fastapi import HTTPException

from app.plugins.papers import library
from app.plugins.papers.connectors import graph, source_settings
from app.core.records.repository import now, store

_run_lock = threading.Lock()
_stop = threading.Event()
_wake = threading.Event()
_worker: threading.Thread | None = None
INTERVAL = timedelta(days=7)
RECENT_WINDOW = timedelta(days=365 * 3)
EXTENDED_WINDOW = timedelta(days=365 * 7)
# OpenAlex semantic search accepts publication_year (not from_publication_date)
# and at most one request per second.
SEMANTIC_INTERVAL = 1.1
STOP_WORDS = {
    "about", "across", "after", "among", "based", "between", "clinical", "data", "effect",
    "effects", "from", "have", "into", "method", "methods", "model", "models", "more",
    "research", "results", "review", "study", "studies", "their", "these", "this", "through",
    "using", "with", "without", "analysis", "approach", "article", "articles", "pour",
    "avec", "dans", "des", "les", "une", "sur", "par", "aux", "ces", "ses", "étude",
    "études", "analyse", "résultats", "méthode", "méthodes", "modèle", "modèles",
}


def list_watches():
    watches = store.list("article_watches")
    for watch in watches:
        for suggestion in watch.get("suggestions", []):
            if "interest_rating" not in suggestion and suggestion.get("relevance_score") is not None:
                suggestion["interest_rating"] = _interest_rating(float(suggestion["relevance_score"]))
    return watches


def save(values: dict, watch_id: int | None = None):
    topics = list(dict.fromkeys(str(value).strip() for value in values["topics"] if str(value).strip()))
    keywords = list(dict.fromkeys(str(value).strip() for value in values.get("keywords", []) if str(value).strip()))
    description = str(values.get("description") or "").strip()
    folders = list(dict.fromkeys(values["folder_ids"]))
    if not values["name"].strip() or any(len(topic) > 200 for topic in topics) or len(description) > 3000 or any(len(keyword) > 100 for keyword in keywords):
        raise HTTPException(422, "Check the name, description, topics and keywords.")
    if not topics and not folders and not keywords and not description:
        raise HTTPException(422, "Add a description, a topic, a keyword or an article folder.")
    known = {folder["id"] for folder in store.list("paper_folders")}
    if any(folder_id not in known for folder_id in folders):
        raise HTTPException(422, "An article folder was not found.")
    data = {"name": values["name"].strip(), "description": description, "topics": topics,
            "keywords": keywords, "folder_ids": folders, "semantic_enabled": values.get("semantic_enabled", True),
            "enabled": values["enabled"], "max_suggestions": values["max_suggestions"]}
    if watch_id is None:
        result = store.create("article_watches", {**data, "last_run_at": None,
            "last_error": None, "suggestions": [], "reports": []})
    else:
        previous = store.find("article_watches", watch_id, "Watch")
        if any(previous.get(key) != data[key] for key in ("topics", "folder_ids", "keywords", "description", "semantic_enabled")):
            data["last_run_at"] = None
        result = store.update("article_watches", watch_id, data, "Watch")
    _wake.set()
    return result


def delete(watch_id: int):
    store.delete("article_watches", watch_id, "Watch")


def _context_papers(watch: dict, state: dict) -> list[dict]:
    selected = set(watch.get("folder_ids") or [])
    while True:
        expanded = selected | {f["id"] for f in state["paper_folders"] if f.get("parent_id") in selected}
        if expanded == selected:
            break
        selected = expanded
    papers = [p for p in state["papers"] if selected.intersection(library.paper_folder_ids(p))]
    return sorted(papers, key=lambda p: str(p.get("updated_at") or p.get("created_at") or ""), reverse=True)[:30]


def _tokens(value: str) -> set[str]:
    return {token.casefold() for token in re.findall(r"[^\W_]{2,}", str(value or ""))
            if (len(token) >= 3 or token.isupper()) and token.casefold() not in STOP_WORDS
            and not token.isdigit()}


def _profile(papers: list[dict]) -> Counter:
    weights = Counter()
    for paper in papers:
        weights.update({term: 4 for term in _tokens(paper.get("title") or "")})
        for tag in paper.get("tags") or []:
            weights.update({term: 5 for term in _tokens(str(tag))})
        weights.update({term: 1 for term in _tokens(str(paper.get("abstract") or "")[:1200])})
    return weights


def _queries(watch: dict, state: dict) -> list[str]:
    queries = list(watch.get("topics") or [])[:12]
    queries.extend(watch.get("keywords") or [])
    papers = _context_papers(watch, state)
    tags = []
    for paper in papers:
        tags.extend(str(tag).strip() for tag in paper.get("tags") or [] if str(tag).strip())
    usable_tags = [tag for tag in tags if _tokens(tag)]
    for tag, _ in Counter(usable_tags).most_common(3):
        if len(_tokens(tag)) >= 1:
            queries.append(tag[:120])
    if not usable_tags and papers:
        common = [term for term, _ in _profile(papers).most_common(6)]
        if len(common) >= 2:
            queries.append(" ".join(common[:4]))
    return list(dict.fromkeys(queries))[:20]


def _semantic_context(watch: dict, papers: list[dict]) -> str:
    rich = [p for p in papers if len(str(p.get("abstract") or "").strip()) >= 80]
    if not rich and not watch.get("description"):
        return ""
    parts = [str(watch.get("description") or ""), *watch.get("topics", [])[:3], *watch.get("keywords", [])[:8]]
    for paper in rich[:3]:
        parts.append(str(paper.get("title") or ""))
        parts.append(str(paper.get("abstract") or "")[:480])
    return "\n".join(parts)[:1900]


def _candidate_score(item: dict, work: dict, watch: dict, papers: list[dict], profile: Counter,
                     query: str, rank: int, semantic: bool) -> tuple[float, list[str]]:
    title_terms = _tokens(item.get("title") or "")
    abstract_terms = _tokens(str(item.get("abstract") or "")[:2400])
    keyword_terms = set().union(*(_tokens(str(k.get("display_name") or "")) for k in work.get("keywords") or []))
    terms = title_terms | abstract_terms | keyword_terms
    topic_hits = sorted(terms & set().union(*(_tokens(t) for t in [*(watch.get("topics") or []), *(watch.get("keywords") or []), watch.get("description") or ""])))
    context_hits = sorted((terms & set(profile)), key=lambda term: profile[term], reverse=True)
    title_hits = set(context_hits) & title_terms
    closest_title = ""
    closest_overlap = 0
    for paper in papers:
        anchor = _tokens(paper.get("title") or "") | set().union(*(_tokens(str(t)) for t in paper.get("tags") or []))
        overlap = len(terms & anchor)
        if overlap > closest_overlap:
            closest_overlap, closest_title = overlap, str(paper.get("title") or "")
    strong_title_hit = any(profile[term] >= 7 for term in title_hits)
    strong_context = len(context_hits) >= 2 and sum(profile[term] for term in context_hits[:4]) >= 6
    if semantic and rank >= 8 and not topic_hits and not context_hits and closest_overlap < 2:
        return 0.0, []
    if not semantic and not topic_hits and not strong_context and not strong_title_hit:
        return 0.0, []
    if not semantic and not papers and not topic_hits:
        return 0.0, []
    score = min(12, len(topic_hits) * 3) + min(10, sum(profile[t] for t in context_hits[:6]) / 5)
    score += min(5, len(title_hits) * 1.5) + min(5, closest_overlap * 1.2)
    score += (2.5 if semantic else 0) + max(0, 2 - rank * .12)
    published = str(work.get("publication_date") or "")
    if published[:4].isdigit():
        score += max(0, 1.5 - (datetime.now(timezone.utc).year - int(published[:4])) * .5)
    reasons = []
    if topic_hits:
        reasons.append("Sujet commun : " + ", ".join(topic_hits[:3]))
    if strong_context:
        reasons.append("Terms close to your articles: " + ", ".join(context_hits[:4]))
    elif title_hits:
        reasons.append("Term from your articles found in the title: " + ", ".join(sorted(title_hits)[:2]))
    if closest_title and closest_overlap >= 2:
        reasons.append("Close to “" + closest_title[:90] + "”")
    if semantic:
        reasons.append("Semantic similarity with the watch context")
    return score, reasons[:3]


def _interest_rating(score: float) -> int:
    """Turn the search evidence into a compact, comparable 0–5 interest rating."""
    if score <= 0:
        return 0
    return 1 + sum(score > threshold for threshold in (5, 9, 13, 18))


def _identity(article: dict) -> str:
    doi = library.normalized_doi(article.get("doi"))
    if doi:
        return "doi:" + doi
    return str(article.get("openalex_id") or article.get("id") or "").casefold()


def _identities(article: dict) -> set[str]:
    title = " ".join(sorted(_tokens(article.get("title") or "")))
    raw_title = unicodedata.normalize("NFKD", str(article.get("title") or "").casefold())
    exact_title = " ".join(re.findall(r"[a-z0-9]+", "".join(char for char in raw_title if not unicodedata.combining(char))))
    url = str(article.get("url") or "").strip()
    parsed = urlsplit(url)
    url_alias = (parsed.netloc.casefold().removeprefix("www.") + parsed.path.rstrip("/").casefold()
                 if parsed.scheme in {"http", "https"} and parsed.netloc else "")
    url_doi = (library.normalized_doi(parsed.path.lstrip("/"))
               if parsed.netloc.casefold() in {"doi.org", "www.doi.org", "dx.doi.org"} else "")
    return {value for value in (_identity(article), str(article.get("openalex_id") or "").casefold(),
                         "doi:" + url_doi if url_doi else "",
                         "title:" + title if len(title) >= 12 else "",
                         "title-exact:" + exact_title if len(exact_title) >= 12 else "",
                         "url:" + url_alias if url_alias else "") if value}


def run(watch_id: int, *, due_only: bool = False, collection: str = "article_watches"):
    if not _run_lock.acquire(blocking=False):
        raise HTTPException(409, "A search is already running.")
    queries = []
    report_id = now()
    try:
        watch = store.find(collection, watch_id, "Watch")
        if due_only and (not watch["enabled"] or not _due(watch)):
            return watch
        if not source_settings.enabled("openalex"):
            raise HTTPException(422, "Enable OpenAlex in the scholarly sources.")
        state = store.read()
        papers = _context_papers(watch, state)
        profile = _profile(papers)
        queries = _queries(watch, state)
        if not queries and not _semantic_context(watch, papers):
            raise HTTPException(422, "This folder does not contain any articles to use as examples yet.")
        seen = set().union(*(_identities(p) for p in [*state["papers"], *watch.get("suggestions", [])]))
        candidates = {}
        candidate_aliases = {}
        failures = []
        examined = 0
        zero_rating_count = 0
        library_duplicate_count = 0
        zero_seen = set()
        library_seen = set()
        attempted = 0
        search_rounds = 0
        last_semantic = 0.0
        cutoff = (datetime.now(timezone.utc) - RECENT_WINDOW).date().isoformat()
        extended_cutoff = (datetime.now(timezone.utc) - EXTENDED_WINDOW).date().isoformat()
        plans = [(query, False) for query in queries]
        semantic_context = _semantic_context(watch, papers) if watch.get("semantic_enabled", True) else ""
        if semantic_context:
            plans.append((semantic_context, True))
        if not plans:
            raise HTTPException(422, "Enable semantic search or add topics and keywords.")
        # Retry with more results, then a wider publication window only if no
        # new and relevant article survived the first pass.
        fallback = plans[:3] + ([plans[-1]] if semantic_context and plans[-1] not in plans[:3] else [])
        rounds = ((plans, cutoff, 20), (fallback, cutoff, 50), (fallback, extended_cutoff, 50))
        for phase, phase_cutoff, page_size in rounds:
            if candidates:
                latest_seen = set().union(*(_identities(p) for p in store.list("papers")))
                seen.update(latest_seen)
                candidates = {key: item for key, item in candidates.items()
                              if not _identities(item).intersection(latest_seen)}
                candidate_aliases = {alias: key for alias, key in candidate_aliases.items() if key in candidates}
                if candidates:
                    break
            search_rounds += 1
            for query, semantic in phase:
                attempted += 1
                try:
                    if semantic:
                        time.sleep(max(0.0, last_semantic + SEMANTIC_INTERVAL - time.monotonic()))
                        last_semantic = time.monotonic()
                        params = {"search.semantic": query, "filter": f"publication_year:>{int(phase_cutoff[:4]) - 1}"}
                    else:
                        params = {"search.title_abstract_keywords": query, "filter": f"from_publication_date:{phase_cutoff}"}
                    payload = graph._request("openalex", "/works?" + urlencode({**params, "per-page": page_size}), timeout=15)
                    for rank, work in enumerate(payload.get("results") or []):
                        # The year filter is coarser than the publication window.
                        if semantic and (work.get("publication_date") or "") < phase_cutoff:
                            continue
                        examined += 1
                        if work.get("is_retracted") or work.get("type") not in (None, "article", "preprint", "review"):
                            continue
                        item = graph._node(work, "watch")
                        key = _identity(item)
                        if not key or not item.get("title"):
                            continue
                        score, reasons = _candidate_score(item, work, watch, papers, profile, query, rank, semantic)
                        rating = _interest_rating(score)
                        if rating == 0:
                            if key not in zero_seen:
                                zero_seen.add(key)
                                zero_rating_count += 1
                            continue
                        aliases = _identities(item)
                        if aliases.intersection(seen):
                            if key not in library_seen:
                                library_seen.add(key)
                                library_duplicate_count += 1
                            continue
                        existing_key = next((candidate_aliases[a] for a in aliases if a in candidate_aliases), None)
                        if existing_key:
                            previous = candidates[existing_key]
                            locations = [work.get("best_oa_location") or {}, work.get("primary_location") or {}, *(work.get("locations") or [])]
                            previous["pdf_urls"] = list(dict.fromkeys([*(previous.get("pdf_urls") or []),
                                *(location["pdf_url"] for location in locations if location.get("pdf_url"))]))
                            previous["pdf_url"] = previous.get("pdf_url") or item.get("pdf_url")
                            if score > previous["relevance_score"]:
                                previous.update(relevance_score=round(score, 2), interest_rating=rating,
                                                match_reasons=reasons, matched_query="Watch context" if semantic else query)
                            continue
                        for alias in aliases:
                            candidate_aliases[alias] = key
                        candidates[key] = {"id": key, "title": item["title"], "authors": item["authors"],
                            "abstract": item["abstract"], "publication": item["publication"],
                            "published_at": str((work.get("publication_date") or item.get("year") or "")),
                            "doi": item["doi"], "url": item["url"], "openalex_id": item["openalex_id"],
                            "pdf_url": item.get("pdf_url"),
                            "pdf_urls": list(dict.fromkeys(location["pdf_url"] for location in
                                [work.get("best_oa_location") or {}, work.get("primary_location") or {}, *(work.get("locations") or [])]
                                if location.get("pdf_url"))),
                            "matched_query": "Watch context" if semantic else query,
                            "match_reasons": reasons, "relevance_score": round(score, 2), "interest_rating": rating,
                            "status": "new", "found_at": report_id, "report_id": report_id}
                except Exception as error:
                    failures.append(("Semantic search" if semantic else f"\"{query}\"") + ": "
                                    + str(error.detail if isinstance(error, HTTPException) else error))
        if failures and len(failures) == attempted:
            raise HTTPException(502, "The OpenAlex search failed: " + failures[0])
        ranked = sorted(candidates.values(), key=lambda item: (
            item["relevance_score"], item.get("published_at") or ""), reverse=True)
        # One run adds a bounded digest. Earlier decisions remain visible.
        with store.transaction() as current:
            record = next((w for w in current[collection] if w["id"] == watch_id), None)
            if record is None:
                raise HTTPException(404, "Watch not found")
            # The library may have changed while external searches were running.
            latest_seen = set().union(*(_identities(p) for p in current["papers"]))
            ranked = [item for item in ranked if not _identities(item).intersection(latest_seen)]
            selected = ranked[:watch.get("max_suggestions") or watch.get("max_items") or 10]
            record["suggestions"] = (selected + record.get("suggestions", []))[:100]
            record["reports"] = ([{"id": report_id, "created_at": report_id,
                "queries": queries + (["Semantic search (watch context)"] if semantic_context else []),
                "context_paper_count": len(papers),
                "examined_count": examined, "relevant_count": len(ranked),
                "zero_rating_count": zero_rating_count, "library_duplicate_count": library_duplicate_count,
                "search_rounds": search_rounds,
                "suggestion_ids": [item["id"] for item in selected],
                "new_count": len(selected), "error_count": len(failures), "errors": list(dict.fromkeys(failures))[:5],
                "summary": (f"{len(selected)} article(s) suggested after reviewing {examined} results"
                            f" en {search_rounds} passage(s).")}] +
                record.get("reports", []))[:52]
            record["last_run_at"] = report_id
            record["last_error"] = (f"{len(failures)} search(es) unavailable — {failures[0]}" if failures else None)
            record["updated_at"] = now()
            return dict(record)
    except Exception as error:
        with store.transaction() as state:
            record = next((w for w in state[collection] if w["id"] == watch_id), None)
            if record:
                message = str(error.detail if isinstance(error, HTTPException) else error)
                record["last_error"] = message
                if queries:
                    record["reports"] = ([{"id": report_id, "created_at": report_id,
                        "queries": queries, "suggestion_ids": [], "new_count": 0,
                        "error_count": len(queries), "summary": "Search interrupted : " + message}] +
                        record.get("reports", []))[:52]
        raise
    finally:
        _run_lock.release()


def decide(watch_id: int, suggestion_id: str, decision: str, collection: str = "article_watches"):
    if decision not in {"saved", "dismissed"}:
        raise HTTPException(422, "Unknown decision")
    watch = store.find(collection, watch_id, "Watch")
    suggestion = next((s for s in watch.get("suggestions", []) if s["id"] == suggestion_id), None)
    if not suggestion:
        raise HTTPException(404, "Suggestion introuvable")
    import_result = None
    if decision == "saved" and suggestion["status"] != "saved":
        values = {key: suggestion.get(key) for key in
            ("title", "authors", "abstract", "publication", "published_at", "doi", "url", "openalex_id", "pdf_url", "pdf_urls")}
        import_result = graph.import_node(None, values | {"origin": "article_watch"})
    with store.transaction() as state:
        record = next(w for w in state[collection] if w["id"] == watch_id)
        item = next(s for s in record["suggestions"] if s["id"] == suggestion_id)
        item["status"] = decision
        record["updated_at"] = now()
        return dict(record) | ({"import_result": import_result} if import_result else {})


def _due(watch: dict) -> bool:
    last = watch.get("last_run_at")
    if not last:
        return True
    try:
        return datetime.now(timezone.utc) - datetime.fromisoformat(last) >= INTERVAL
    except ValueError:
        return True


def _loop():
    while not _stop.is_set():
        for watch in list_watches():
            if watch.get("enabled") and _due(watch):
                try:
                    run(watch["id"], due_only=True)
                except Exception:
                    pass  # The error is persisted for display in the library.
        _wake.wait(3600)
        _wake.clear()


def start():
    global _worker
    if _worker and _worker.is_alive():
        return
    _stop.clear()
    _wake.clear()
    _worker = threading.Thread(target=_loop, name="article-watch", daemon=True)
    _worker.start()


def stop():
    _stop.set()
    _wake.set()
    if _worker:
        _worker.join(timeout=2)
