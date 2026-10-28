"""Text helpers shared by the search index and the workspace map.

``words`` splits text the way the FTS5 ``unicode61 remove_diacritics 2``
tokenizer does, so terms counted here match the index's vocabulary.
"""
from __future__ import annotations

import re
import unicodedata

STOP_WORDS = frozenset("""
a about after all also an and any are as at be been but by can could did do does each for from had has have
how if in into is it its may more most no not of on or other our out over same should so some such than that
the their them then there these they this those through to under up use used using was we were what when where
which while who will with within would you your
au aux avec ce ces cet cette comme dans de des du elle elles en entre est et été être eux il ils je la le les
leur leurs lui mais me même mes moi mon ne nos notre nous on ou où par pas peu plus pour qu que quel quelle
qui sa sans se ses si son sont sur ta te tes toi ton tous tout toute toutes très tu un une vos votre vous
y à ça été non oui aussi ainsi donc car cela celui celle ceux après avant chez sous lors puis selon
yet however thus also one two new well many much very just only often less least top key""".split())
WORD = re.compile(r"[^\W_]+")


def fold(text: str) -> str:
    """Lowercase without accents: « Résumé » → « resume »."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.casefold()) if not unicodedata.combining(c))


def words(text: str) -> list[str]:
    return WORD.findall(fold(text))


def terms(text: str) -> list[str]:
    """Words worth counting as keywords: no stop words, numbers or short tokens."""
    return [w for w in words(text) if len(w) >= 3 and not w.isdigit() and w not in STOP_WORDS]


def first_sentences(text: str, limit: int = 200) -> str:
    """The start of a text cut at a sentence (or word) boundary."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    if end >= limit * 0.4:
        return cut[:end + 1]
    return cut[:cut.rfind(" ")].rstrip(",;:") + "…" if " " in cut else cut + "…"


def tokens(chars: int) -> int:
    """Rough token count of a text of this length (about four characters per token)."""
    return max(1, round(chars / 4))
