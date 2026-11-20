"""Text to the phonemes Kokoro was trained on, with pronunciations of our own.

Kokoro v1.0 learned misaki's phonemes. kokoro-onnx phonemizes with espeak-ng
unless handed phonemes, and espeak writes a different alphabet: a diphthong as
two vowels where the model learned one symbol ("hˈeɪ" for "hˈA"), "ɚ" for
"əɹ", length marks it never saw, and its own guesses at names ("ˈɛdmʌnd",
ed-MUND, for Edmund).

Measured 2026-11-12 on 200 sentences Edmund had said on calls (am_fenrir at
1.05, the result transcribed by Parakeet): 49 of 2,229 words came back wrong
from espeak's phonemes and 31 from misaki's, which was better on 18 sentences
and worse on 3. "Yeah." alone was inaudible from espeak; "Yeah, ..." was
heard as "Yay", "Ha, ..." as "How", "Hey" as "A".

misaki is not better at everything: its lexicon writes "Hmm" as the letters
"hmm", no vowel, which Kokoro renders as noise (heard as "And Millie."). So a
word can be given its phonemes here, and the operator can add more in a file
(`KOKORO_PRONOUNCE`), read again whenever it changes:

    {"Edmund": "ˈɛdmən"}

A word is matched whole and in any case, and never before a possessive 's
(the lexicon's own form is right there). Phonemes are misaki's alphabet; see
https://github.com/hexgrad/misaki/blob/main/EN_PHONES.md
"""

from __future__ import annotations

import json
import os
import re

# Words misaki's lexicon spells without a vowel. Measured, not guessed: each
# was synthesized and transcribed before and after.
BUILT_IN = {"hmm": "həm", "hm": "həm"}

# What cannot sit inside misaki's [word](/phonemes/) markup.
_UNSAFE = re.compile(r"[/()\[\]\s]")


def valid_overrides(raw, log) -> dict[str, str]:
    """The usable entries of an overrides file: a word to its phonemes."""
    if not isinstance(raw, dict):
        log("pronunciations ignored: the file is not an object of word to phonemes")
        return {}
    out: dict[str, str] = {}
    for word, phonemes in raw.items():
        if (
            isinstance(word, str)
            and isinstance(phonemes, str)
            and re.fullmatch(r"[A-Za-z][A-Za-z'-]*", word)
            and phonemes
            and not _UNSAFE.search(phonemes)
        ):
            out[word.lower()] = phonemes
        else:
            log(f"pronunciation ignored: {word!r}")
    return out


def mark(text: str, overrides: dict[str, str]) -> str:
    """`text` with each overridden word wrapped in misaki's pronunciation markup."""
    if not overrides:
        return text
    words = "|".join(re.escape(w) for w in sorted(overrides, key=len, reverse=True))
    # Whole words only, not one already marked ("]" follows it), and not a possessive.
    pattern = re.compile(rf"(?<![\w/'’-])({words})(?![\w\]/-]|['’]\w)", re.IGNORECASE)
    return pattern.sub(lambda m: f"[{m.group(1)}](/{overrides[m.group(1).lower()]}/)", text)


class Overrides:
    """The built-in pronunciations plus the operator's file, re-read when it changes."""

    def __init__(self, path: str | None, log):
        self._path = path
        self._log = log
        self._stamp: tuple[float, int] | None = None
        self._current = dict(BUILT_IN)

    def current(self) -> dict[str, str]:
        if not self._path:
            return self._current
        try:
            stat = os.stat(self._path)
            stamp = (stat.st_mtime, stat.st_size)
        except OSError:
            stamp = None
        if stamp != self._stamp:
            self._stamp = stamp
            extra: dict[str, str] = {}
            if stamp is not None:
                try:
                    with open(self._path, encoding="utf-8") as handle:
                        extra = valid_overrides(json.load(handle), self._log)
                except (OSError, ValueError) as err:
                    self._log(f"pronunciations unreadable ({err}); using the built-in ones")
            self._current = {**BUILT_IN, **extra}
            self._log(f"pronunciations: {len(self._current)} words")
        return self._current


def load(path: str | None, log):
    """A function from text to misaki phonemes, or None when misaki is not installed.

    None is not a failure: the caller hands Kokoro the text and it phonemizes
    with espeak, as it always did.
    """
    try:
        from misaki import en, espeak
    except Exception as err:  # noqa: BLE001 - any import failure means the same thing
        log(f"misaki unavailable ({err}); phonemes come from espeak (scripts/install-kokoro.sh adds it)")
        return None
    try:
        fallback = espeak.EspeakFallback(british=False)
    except Exception as err:  # noqa: BLE001
        log(f"misaki has no espeak fallback ({err}); words outside its lexicon will be skipped")
        fallback = None
    g2p = en.G2P(trf=False, british=False, fallback=fallback)
    overrides = Overrides(path, log)

    def phonemes(text: str) -> str | None:
        out, _tokens = g2p(mark(text, overrides.current()))
        return out if out and out.strip() else None

    return phonemes
