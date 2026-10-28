"""Themes of a set of items: distinctive keywords, and clusters by meaning when embeddings exist.

Keywords are always available: words frequent in the set but rare in the rest
of the workspace (TF-IDF over the search index's vocabulary). With local
embeddings, items are also grouped by meaning (k-means on their vectors) and
each group is labelled with its own distinctive words.
"""
from __future__ import annotations

import math
import random
import threading
from collections import Counter
from typing import Any

from app.core.search.text import fold, terms

MAX_CLUSTER_ITEMS = 600
_cache: dict[Any, Any] = {}
_lock = threading.Lock()


def keywords(texts: list[str], index, limit: int = 8) -> list[str]:
    counts: Counter = Counter()
    surface: dict[str, Counter] = {}
    for text in texts:
        for word in terms(text):
            counts[word] += 1
        for original in text.split():
            cleaned = original.strip(".,;:!?()[]{}«»\"'").casefold()
            if len(cleaned) >= 3:
                surface.setdefault(fold(cleaned), Counter())[cleaned] += 1
    if not counts:
        return []
    frequent = [word for word, _ in counts.most_common(400)]
    df, total = index.document_frequencies(frequent)
    scored = sorted(frequent, key=lambda w: counts[w] * math.log((total + 1) / (df.get(w, 0) + 1)), reverse=True)
    # Repeated words first: a word seen once says little about a text.
    ordered = [w for w in scored if counts[w] > 1] + [w for w in scored if counts[w] == 1]
    result = []
    for word in ordered:
        shown = surface.get(word, Counter({word: 1})).most_common(1)[0][0]
        if shown not in result:
            result.append(shown)
        if len(result) >= limit:
            break
    return result


def _normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


def _dot(a, b) -> float:
    return sum(x * y for x, y in zip(a, b))


def _kmeans(points: list[list[float]], k: int, iterations: int = 12) -> list[int]:
    rng = random.Random(7)
    centroids = [points[rng.randrange(len(points))]]
    while len(centroids) < k:
        # k-means++: favour points far from the centroids already chosen.
        distances = [1 - max(_dot(p, c) for c in centroids) for p in points]
        total = sum(distances) or 1.0
        pick, acc = rng.random() * total, 0.0
        for point, distance in zip(points, distances):
            acc += distance
            if acc >= pick:
                centroids.append(point)
                break
        else:
            centroids.append(points[-1])
    assignment = [0] * len(points)
    for _ in range(iterations):
        changed = False
        for i, point in enumerate(points):
            best = max(range(k), key=lambda c: _dot(point, centroids[c]))
            changed |= best != assignment[i]
            assignment[i] = best
        for c in range(k):
            members = [points[i] for i in range(len(points)) if assignment[i] == c]
            if members:
                centroids[c] = _normalize([sum(values) / len(members) for values in zip(*members)])
        if not changed:
            break
    return assignment


def clusters(index, *, collection: str | None = None, project_id: int | None = None,
             allowed: set[str] | None = None) -> list[dict[str, Any]] | None:
    """Groups of items by meaning, or None when embeddings are off or too few items have vectors."""
    rows = index.scope_ids(collection=collection, project_id=project_id)
    if allowed is not None:
        rows = [r for r in rows if f"kavot://{r[1]}/{r[2]}" in allowed]
    key = (collection, project_id, index.generation(), frozenset(allowed) if allowed is not None else None)
    with _lock:
        if key in _cache:
            return _cache[key]
    vectors = index.vectors([r[0] for r in rows])
    by_item: dict[tuple[str, str], list] = {}
    for identifier, coll, item_id in rows:
        if identifier in vectors:
            by_item.setdefault((coll, item_id), []).append(vectors[identifier])
    if len(by_item) < 8:
        return None
    items = sorted(by_item)[:MAX_CLUSTER_ITEMS]
    points = [_normalize([sum(values) / len(vs) for values in zip(*vs)]) for vs in (by_item[i] for i in items)]
    k = min(6, max(2, round(math.sqrt(len(points) / 2))))
    assignment = _kmeans(points, k)
    titles = {(i["collection"], i["item_id"]): i for i in index.items(collection=collection, project_id=project_id)}
    groups = []
    for c in range(k):
        members = [n for n, a in enumerate(assignment) if a == c]
        if not members:
            continue
        centroid = _normalize([sum(values) / len(members) for values in zip(*(points[n] for n in members))])
        members.sort(key=lambda n: _dot(points[n], centroid), reverse=True)
        infos = [titles.get(items[n], {"title": items[n][1], "lead": ""}) for n in members]
        label = keywords([f"{info['title']} {info['lead']}" for info in infos], index, limit=4)
        groups.append({"label": " · ".join(label) or infos[0]["title"], "size": len(members),
                       "examples": [{"ref": f"kavot://{items[n][0]}/{items[n][1]}", "title": info["title"]}
                                    for n, info in zip(members[:4], infos[:4])]})
    groups.sort(key=lambda g: g["size"], reverse=True)
    with _lock:
        if len(_cache) > 64:
            _cache.clear()
        _cache[key] = groups
    return groups
