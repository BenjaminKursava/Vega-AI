"""Live index of the models published in Ollama's public library.

Ollama exposes no search or catalogue API — ``/v2/_catalog`` and
``/v2/<name>/tags/list`` on registry.ollama.ai both 404, and there is no
JSON endpoint on ollama.com. The only complete source is the HTML at
https://ollama.com/library, so this module fetches and parses it.

Because that is scraping, everything here is written to degrade rather
than break:

* the parser keys off the ``/library/<name>`` links and the shape of the
  size chips ("8b", "8x7b"), not off Tailwind class names, which change;
* results are cached on disk, so a layout change or an offline machine
  keeps serving the last good list instead of an empty one;
* the caller always has the frontend's built-in shortlist to fall back to.

This runs server-side rather than in the browser because the app's own
Content-Security-Policy (``default-src 'self'``) forbids the page from
fetching ollama.com directly.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

LIBRARY_URL = "https://ollama.com/library"
_CACHE_TTL_SECONDS = 6 * 3600
_FETCH_TIMEOUT_SECONDS = 20.0

# <a href="/library/llama3.3" ...>
_MODEL_LINK_RE = re.compile(r'href="/library/([A-Za-z0-9._-]+)"')
# <p class="max-w-lg ...">New state of the art 70B model...</p>
_DESCRIPTION_RE = re.compile(
    r'<p[^>]*class="[^"]*max-w-lg[^"]*"[^>]*>(.*?)</p>', re.DOTALL
)
# Any chip: <span ... class="inline-flex ...">70b</span>
_CHIP_RE = re.compile(
    r'<span[^>]*class="[^"]*inline-flex[^"]*"[^>]*>(.*?)</span>', re.DOTALL
)
# A chip is a parameter size if it reads like 8b / 1.5b / 8x7b / 671b.
_SIZE_CHIP_RE = re.compile(r"^\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?[bm]$", re.IGNORECASE)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")


def _text(fragment: str) -> str:
    """Strip tags and collapse whitespace/entities in an HTML fragment."""
    out = _TAG_STRIP_RE.sub("", fragment)
    out = (
        out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )
    return " ".join(out.split())


def parse_library_html(html: str) -> List[Dict[str, Any]]:
    """Extract one record per model from the library page.

    Kept as a pure function so it can be tested against a saved page.
    """
    models: List[Dict[str, Any]] = []
    seen: set[str] = set()

    # Each model sits in its own <li>. Splitting on the list item keeps a
    # model's description and chips from bleeding into its neighbour.
    for block in html.split("<li")[1:]:
        link = _MODEL_LINK_RE.search(block)
        if not link:
            continue
        name = link.group(1)
        if name in seen:
            continue

        desc_match = _DESCRIPTION_RE.search(block)
        description = _text(desc_match.group(1)) if desc_match else ""

        sizes: List[str] = []
        capabilities: List[str] = []
        for chip_html in _CHIP_RE.findall(block):
            chip = _text(chip_html)
            if not chip:
                continue
            if _SIZE_CHIP_RE.match(chip):
                if chip.lower() not in sizes:
                    sizes.append(chip.lower())
            elif chip.lower() not in capabilities and len(chip) < 24:
                capabilities.append(chip.lower())

        seen.add(name)
        models.append(
            {
                "name": name,
                "description": description,
                "sizes": sizes,
                "capabilities": capabilities,
                # Tags a user can actually pull. ":latest" always resolves;
                # each advertised size is a valid tag too.
                "tags": ["latest"] + sizes,
            }
        )

    return models


class OllamaLibraryIndex:
    """Fetches, parses and caches the library listing."""

    def __init__(self, cache_path: Optional[Path] = None) -> None:
        if cache_path is None:
            cache_path = Path.home() / ".openjarvis" / "ollama-library.json"
        self._cache_path = cache_path
        self._lock = threading.Lock()
        self._models: List[Dict[str, Any]] = []
        self._fetched_at: float = 0.0
        self._load_disk_cache()

    # -- disk cache ----------------------------------------------------

    def _load_disk_cache(self) -> None:
        try:
            if not self._cache_path.exists():
                return
            data = json.loads(self._cache_path.read_text(encoding="utf-8"))
            models = data.get("models")
            if isinstance(models, list) and models:
                self._models = models
                self._fetched_at = float(data.get("fetched_at", 0.0))
        except Exception:
            logger.debug("Could not read the Ollama library cache", exc_info=True)

    def _save_disk_cache(self) -> None:
        try:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            self._cache_path.write_text(
                json.dumps(
                    {"fetched_at": self._fetched_at, "models": self._models},
                    indent=0,
                ),
                encoding="utf-8",
            )
        except Exception:
            logger.debug("Could not write the Ollama library cache", exc_info=True)

    # -- fetching ------------------------------------------------------

    def _fetch(self) -> List[Dict[str, Any]]:
        import httpx

        resp = httpx.get(
            LIBRARY_URL,
            timeout=_FETCH_TIMEOUT_SECONDS,
            follow_redirects=True,
            headers={"User-Agent": "OpenJarvis/0.1 (+local model browser)"},
        )
        resp.raise_for_status()
        return parse_library_html(resp.text)

    def get(self, force_refresh: bool = False) -> Dict[str, Any]:
        """Return ``{models, fetched_at, stale, source, error}``.

        Never raises: on a failed fetch the last good cache is returned
        with ``stale: True`` and the error text, so the UI can show
        something useful and say why it might be out of date.
        """
        with self._lock:
            age = time.time() - self._fetched_at
            fresh_enough = self._models and age < _CACHE_TTL_SECONDS

            if fresh_enough and not force_refresh:
                return {
                    "models": self._models,
                    "fetched_at": self._fetched_at,
                    "stale": False,
                    "source": "cache",
                    "error": None,
                }

            try:
                models = self._fetch()
                if not models:
                    raise ValueError(
                        "The library page returned no models — its layout "
                        "has probably changed."
                    )
                self._models = models
                self._fetched_at = time.time()
                self._save_disk_cache()
                return {
                    "models": self._models,
                    "fetched_at": self._fetched_at,
                    "stale": False,
                    "source": "live",
                    "error": None,
                }
            except Exception as exc:
                logger.warning("Ollama library fetch failed: %s", exc)
                return {
                    "models": self._models,
                    "fetched_at": self._fetched_at,
                    "stale": True,
                    "source": "cache" if self._models else "none",
                    "error": str(exc),
                }


_index: Optional[OllamaLibraryIndex] = None
_index_lock = threading.Lock()


def get_library_index() -> OllamaLibraryIndex:
    global _index
    if _index is None:
        with _index_lock:
            if _index is None:
                _index = OllamaLibraryIndex()
    return _index


__all__ = ["OllamaLibraryIndex", "get_library_index", "parse_library_html"]
