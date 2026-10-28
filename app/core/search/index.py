"""Local search index: SQLite FTS5, rebuilt incrementally from the workspace.

The index lives in ``<workspace>/.kavot-local/search.sqlite``. It is derived
data: it is never synced nor backed up, and deleting it only costs a rebuild.

Search runs in stages, cheapest first, and stops returning text early:

1. lexical — FTS5 BM25 over titles and text (accents and case ignored);
2. fuzzy — trigram matching, only when the lexical stage finds too little
   (typos, partial words, compound words);
3. semantic — when local embeddings are enabled, candidates are re-ranked by
   meaning and the whole index is scanned for passages that share no word
   with the query; ranks are merged with reciprocal rank fusion.

Hits carry an address, a title and a short snippet. Full text is read on
demand, passage by passage, so an agent pays only for what it opens.
"""
from __future__ import annotations

import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from app.core.search import embeddings
from app.core.search.documents import Unchanged, all_documents

SYNC_INTERVAL = 30.0
CANDIDATES = 60
RRF_K = 60
EMBED_BATCH = 64
SNIPPET_CHARS = 220
STOP_WORDS = {"the", "and", "for", "with", "les", "des", "une", "dans", "pour", "par", "sur", "est", "qui", "que", "aux", "du", "de", "la", "le", "et", "un", "of", "to", "in", "a", "an", "is", "on"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, grp TEXT NOT NULL, version TEXT NOT NULL,
  collection TEXT NOT NULL, item_id TEXT NOT NULL, anchor TEXT NOT NULL, title TEXT NOT NULL,
  text TEXT NOT NULL, projects TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS docs_grp ON docs(grp);
CREATE INDEX IF NOT EXISTS docs_item ON docs(collection, item_id);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, text, content='docs', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS tri USING fts5(title, text, content='docs', content_rowid='id', tokenize='trigram');
CREATE TABLE IF NOT EXISTS vectors (id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS vocab USING fts5vocab(fts, 'row');
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO fts(rowid, title, text) VALUES (new.id, new.title, new.text);
  INSERT INTO tri(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO fts(fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO tri(tri, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  DELETE FROM vectors WHERE id = old.id;
END;
"""


class Index:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()
        self.synced_at = 0.0
        self.dirty = True

    # -- building -------------------------------------------------------
    def sync(self, state: dict[str, Any], force: bool = False) -> dict[str, int]:
        with self.lock:
            if not force and not self.dirty and time.monotonic() - self.synced_at < SYNC_INTERVAL:
                return {"changed": 0, "removed": 0}
            known = dict(self.db.execute("SELECT grp, version FROM docs GROUP BY grp"))
            seen, fresh = set(), {}
            for item in all_documents(state, known):
                if isinstance(item, Unchanged):
                    seen.add(item.group)
                elif known.get(item.group) == item.version and item.group not in fresh:
                    seen.add(item.group)
                else:
                    fresh.setdefault(item.group, []).append(item)
            removed = set(known) - seen - set(fresh)
            with self.db:
                for group in [*fresh, *removed]:
                    self.db.execute("DELETE FROM docs WHERE grp = ?", (group,))
                for group_docs in fresh.values():
                    self.db.executemany(
                        "INSERT OR REPLACE INTO docs(ref, grp, version, collection, item_id, anchor, title, text, projects, updated_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        [(d.ref, d.group, d.version, d.collection, d.item_id, d.anchor, d.title, d.text,
                          "," + ",".join(map(str, d.project_ids)) + ",", d.updated_at or "") for d in group_docs])
            self.synced_at, self.dirty = time.monotonic(), False
            return {"changed": len(fresh), "removed": len(removed)}

    def embed_pending(self, limit: int = EMBED_BATCH, ids: Iterable[int] | None = None) -> int:
        """Embed documents that have no vector for the active model yet."""
        provider = embeddings.provider()
        if provider is None:
            return 0
        with self.lock:
            if ids is not None:
                marks = ",".join("?" * len(ids := list(ids)))
                rows = self.db.execute(f"SELECT d.id, d.title, d.text FROM docs d LEFT JOIN vectors v ON v.id = d.id AND v.model = ?"
                                       f" WHERE v.id IS NULL AND d.id IN ({marks})", (provider.name, *ids)).fetchall()
            else:
                rows = self.db.execute("SELECT d.id, d.title, d.text FROM docs d LEFT JOIN vectors v ON v.id = d.id AND v.model = ?"
                                       " WHERE v.id IS NULL LIMIT ?", (provider.name, limit)).fetchall()
        if not rows:
            return 0
        vectors = provider.embed([f"{title}\n{text}"[:2000] for _, title, text in rows])
        with self.lock, self.db:
            self.db.executemany("INSERT OR REPLACE INTO vectors(id, model, vec) VALUES (?, ?, ?)",
                                [(row[0], provider.name, embeddings.pack(vector)) for row, vector in zip(rows, vectors)])
        return len(rows)

    # -- querying -------------------------------------------------------
    @staticmethod
    def terms(query: str) -> list[str]:
        words = [w for w in re.findall(r"\w+", query.casefold()) if len(w) > 1]
        kept = [w for w in words if w not in STOP_WORDS]
        return kept or words

    def _filters(self, collections: list[str] | None, project_id: int | None, allowed: set[str] | None):
        clauses, params = [], []
        if collections:
            clauses.append(f"d.collection IN ({','.join('?' * len(collections))})")
            params += collections
        if project_id is not None:
            clauses.append("d.projects LIKE ?")
            params.append(f"%,{int(project_id)},%")
        if allowed is not None:
            if not allowed:
                clauses.append("0")
            else:
                clauses.append(f"d.collection IN ({','.join('?' * len(allowed))})")
                params += sorted(allowed)
        return (" AND " + " AND ".join(clauses)) if clauses else "", params

    def _lexical(self, terms, where, params, limit):
        if not terms:
            return []
        match = " OR ".join(f'"{term}"*' for term in terms)
        sql = (f"SELECT d.id, snippet(fts, 1, '«', '»', '…', 18) FROM fts JOIN docs d ON d.id = fts.rowid"
               f" WHERE fts MATCH ? {where} ORDER BY bm25(fts, 4.0, 1.0) LIMIT ?")
        return self.db.execute(sql, (match, *params, limit)).fetchall()

    def _fuzzy(self, terms, where, params, limit):
        """Typo-tolerant stage: documents sharing most trigrams of each word."""
        import unicodedata
        def fold(text):
            return "".join(c for c in unicodedata.normalize("NFKD", text.casefold()) if not unicodedata.combining(c))
        words = [fold(term) for term in terms if len(term) >= 3]
        grams = {word: {word[i:i + 3] for i in range(len(word) - 2)} for word in words}
        every = sorted(set().union(*grams.values())) if grams else []
        if not every:
            return []
        match = " OR ".join(f'"{gram}"' for gram in every)
        sql = (f"SELECT d.id, d.title, d.text FROM tri JOIN docs d ON d.id = tri.rowid"
               f" WHERE tri MATCH ? {where} ORDER BY bm25(tri, 4.0, 1.0) LIMIT ?")
        rows = self.db.execute(sql, (match, *params, limit * 4)).fetchall()
        from difflib import SequenceMatcher

        def close(query, word):
            # A partial word ("ablat") or a word one or two typos away ("calibrte"); sharing a
            # suffix with another word ("nation" / "ablation") is not enough.
            if len(query) >= 4 and word.startswith(query):
                return True
            return abs(len(word) - len(query)) <= 2 and SequenceMatcher(None, query, word).ratio() >= 0.8

        kept = []
        for identifier, title, text in rows:
            vocabulary = set(re.findall(r"\w{3,}", fold(f"{title} {text}")))
            if any(close(query, word) for query in grams for word in vocabulary):
                kept.append((identifier, None))
            if len(kept) >= limit:
                break
        return kept

    def _semantic(self, query, where, params, candidate_ids, limit):
        provider = embeddings.provider()
        if provider is None:
            return []
        self.embed_pending(ids=candidate_ids)
        query_vector = embeddings.unpack(embeddings.pack(provider.embed([query])[0]))
        rows = self.db.execute(f"SELECT d.id, v.vec FROM vectors v JOIN docs d ON d.id = v.id WHERE v.model = ? {where}",
                               (provider.name, *params)).fetchall()
        scored = sorted(((embeddings.cosine(query_vector, embeddings.unpack(blob)), identifier) for identifier, blob in rows), reverse=True)
        return [(identifier, None) for _, identifier in scored[:limit]]

    def search(self, query: str, *, collections: list[str] | None = None, project_id: int | None = None,
               allowed: set[str] | None = None, mode: str = "auto", limit: int = 10, offset: int = 0,
               group_items: bool = True) -> dict[str, Any]:
        terms = self.terms(query)
        where, params = self._filters(collections, project_id, allowed)
        stages, rankings = [], []
        with self.lock:
            lexical = [] if mode == "semantic" else self._lexical(terms, where, params, CANDIDATES)
            if lexical:
                stages.append("lexical")
                rankings.append(lexical)
            if mode != "semantic" and len(lexical) < offset + limit:
                fuzzy = self._fuzzy(terms, where, params, CANDIDATES)
                if fuzzy:
                    stages.append("fuzzy")
                    rankings.append(fuzzy)
            if mode in {"auto", "semantic"}:
                candidates = list(dict.fromkeys(row[0] for ranking in rankings for row in ranking))
                semantic = self._semantic(query, where, params, candidates, CANDIDATES)
                if semantic:
                    stages.append("semantic")
                    rankings.append(semantic)
            scores, snippets = {}, {}
            for ranking in rankings:
                for rank, (identifier, snippet) in enumerate(ranking):
                    scores[identifier] = scores.get(identifier, 0.0) + 1.0 / (RRF_K + rank + 1)
                    if snippet and identifier not in snippets:
                        snippets[identifier] = snippet
            ordered = sorted(scores, key=scores.get, reverse=True)
            rows = {}
            if ordered:
                marks = ",".join("?" * len(ordered))
                for row in self.db.execute(f"SELECT id, ref, collection, item_id, anchor, title, text, projects FROM docs WHERE id IN ({marks})", ordered):
                    rows[row[0]] = row
        hits, by_item = [], {}
        for identifier in ordered:
            row = rows.get(identifier)
            if row is None:
                continue
            _, address, collection, item_id, anchor, title, text, projects = row
            item = (collection, item_id)
            if group_items and item in by_item:
                by_item[item]["more"] = by_item[item].get("more", 0) + 1
                continue
            snippet = snippets.get(identifier) or (text[:SNIPPET_CHARS] + ("…" if len(text) > SNIPPET_CHARS else ""))
            hit = {"ref": address, "collection": collection, "title": title, "snippet": snippet,
                   "score": round(scores[identifier] * 100, 2)}
            project_ids = [int(value) for value in projects.strip(",").split(",") if value]
            if project_ids:
                hit["project_ids"] = project_ids
            by_item[item] = hit
            hits.append(hit)
        page = hits[offset:offset + limit]
        return {"query": query, "stages": stages, "total": len(hits), "hits": page,
                "next_offset": offset + limit if offset + limit < len(hits) else None}

    def passages(self, collection: str, item_id: str) -> list[dict[str, str]]:
        with self.lock:
            return [{"ref": r, "anchor": a, "text": t} for r, a, t in self.db.execute(
                "SELECT ref, anchor, text FROM docs WHERE collection = ? AND item_id = ? ORDER BY id", (collection, str(item_id)))]

    def item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        """Title, projects and ordered passages of one indexed item."""
        with self.lock:
            rows = self.db.execute("SELECT ref, anchor, title, text, projects, id FROM docs WHERE collection = ? AND item_id = ? ORDER BY id",
                                   (collection, str(item_id))).fetchall()
        if not rows:
            return None
        return {"title": rows[0][2], "project_ids": [int(v) for v in rows[0][4].strip(",").split(",") if v],
                "passages": [{"ref": r, "anchor": a, "text": t, "id": i} for r, a, _, t, _, i in rows]}

    def items(self, *, collection: str | None = None, project_id: int | None = None) -> list[dict[str, Any]]:
        """One row per indexed item: collection, id, title, first passage and total size."""
        clauses, params = [], []
        if collection:
            clauses.append("collection = ?")
            params.append(collection)
        if project_id is not None:
            clauses.append("projects LIKE ?")
            params.append(f"%,{int(project_id)},%")
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.lock:
            rows = self.db.execute(f"SELECT collection, item_id, min(id), title, sum(length(text)), count(*), max(updated_at) FROM docs {where}"
                                   f" GROUP BY collection, item_id ORDER BY max(updated_at) DESC", params).fetchall()
            firsts = dict(self.db.execute(f"SELECT id, text FROM docs WHERE id IN ({','.join(str(r[2]) for r in rows) or '0'})"))
        return [{"collection": c, "item_id": i, "title": title, "lead": firsts.get(first, ""), "chars": chars or 0,
                 "passages": count, "updated_at": updated} for c, i, first, title, chars, count, updated in rows]

    def document_frequencies(self, terms: list[str]) -> tuple[dict[str, int], int]:
        """How many indexed documents contain each term, and the number of documents."""
        if not terms:
            return {}, 0
        with self.lock:
            total = self.db.execute("SELECT count(*) FROM docs").fetchone()[0]
            found = {}
            for start in range(0, len(terms), 400):
                chunk = terms[start:start + 400]
                found.update(self.db.execute(f"SELECT term, doc FROM vocab WHERE term IN ({','.join('?' * len(chunk))})", chunk))
        return found, total

    def vectors(self, ids: list[int]) -> dict[int, Any]:
        provider = embeddings.provider()
        if provider is None or not ids:
            return {}
        with self.lock:
            found = {}
            for start in range(0, len(ids), 500):
                chunk = ids[start:start + 500]
                found.update((i, embeddings.unpack(blob)) for i, blob in self.db.execute(
                    f"SELECT id, vec FROM vectors WHERE model = ? AND id IN ({','.join('?' * len(chunk))})", (provider.name, *chunk)))
        return found

    def scope_ids(self, *, collection: str | None = None, project_id: int | None = None) -> list[tuple[int, str, str]]:
        """(document id, collection, item id) of every document in a collection or project."""
        clauses, params = [], []
        if collection:
            clauses.append("collection = ?")
            params.append(collection)
        if project_id is not None:
            clauses.append("projects LIKE ?")
            params.append(f"%,{int(project_id)},%")
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.lock:
            return self.db.execute(f"SELECT id, collection, item_id FROM docs {where}", params).fetchall()

    def generation(self) -> tuple[int, int]:
        """Changes whenever documents or vectors change; used to cache derived views."""
        with self.lock:
            docs = self.db.execute("SELECT count(*), coalesce(max(id), 0) FROM docs").fetchone()
            vectors = self.db.execute("SELECT count(*) FROM vectors").fetchone()[0]
        return (docs[0] * 1_000_003 + docs[1], vectors)

    def stats(self) -> dict[str, Any]:
        with self.lock:
            count = self.db.execute("SELECT count(*) FROM docs").fetchone()[0]
            by_collection = dict(self.db.execute("SELECT collection, count(DISTINCT item_id) FROM docs GROUP BY collection"))
            vectors = self.db.execute("SELECT count(*) FROM vectors").fetchone()[0]
        return {"documents": count, "items": by_collection, "vectors": vectors}

    def close(self):
        with self.lock:
            self.db.close()


_lock = threading.Lock()
_index: Index | None = None
_filler: threading.Thread | None = None


def index_path() -> Path:
    from app.core.kernel.config import settings
    return settings.storage_path / ".kavot-local" / "search.sqlite"


def get() -> Index:
    """The index of the current workspace (the workspace folder can change at runtime)."""
    global _index
    with _lock:
        path = index_path()
        if _index is None or _index.path != path:
            if _index is not None:
                _index.close()
            _index = Index(path)
        return _index


def mark_dirty() -> None:
    if _index is not None:
        _index.dirty = True


def _fill_vectors(index: Index) -> None:
    try:
        while index.embed_pending():
            pass
    except Exception:  # Embedding is best effort; lexical search keeps working.
        pass


def ensure_fresh(force: bool = False) -> Index:
    global _filler
    from app.core.records.repository import store
    index = get()
    index.sync(store.read(), force=force)
    if embeddings.provider() is not None and (_filler is None or not _filler.is_alive()):
        _filler = threading.Thread(target=_fill_vectors, args=(index,), daemon=True, name="kavot-embeddings")
        _filler.start()
    return index
