"""Check for newer OpenJarvis releases on GitHub."""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_CACHE_PATH = Path("~/.openjarvis/version-check.json").expanduser()
_CACHE_TTL = 86400  # 24 hours
_GITHUB_API = "https://api.github.com/repos/open-jarvis/OpenJarvis/releases/latest"
_CHECK_COMMANDS = {"ask", "chat", "serve"}


# Update checking is DISABLED in this build.
#
# This is a personal, customised copy of OpenJarvis — it is not tracking
# upstream releases, so there is nothing useful to be told about. Turning
# it off also means the app never contacts api.github.com on startup, and
# therefore never exposes this machine's IP address to GitHub.
#
# Set this to True only if you want release notifications back.
UPDATE_CHECK_ENABLED = False


def check_for_updates(command_name: str) -> None:
    """No-op: update checking is switched off in this build.

    Returns before any network code can run. The machinery below is left
    in place so re-enabling is a one-line change, but nothing calls it.
    """
    if not UPDATE_CHECK_ENABLED:
        return
    if command_name not in _CHECK_COMMANDS:
        return
    try:
        _do_check()
    except Exception:
        pass


def _do_check() -> None:
    import openjarvis

    current = openjarvis.__version__
    latest = _get_latest_version(current)
    if latest is None:
        return

    from packaging.version import InvalidVersion, Version

    try:
        if Version(latest) > Version(current):
            sys.stderr.write(
                f"\033[33mA new version of OpenJarvis is available "
                f"(v{current} \u2192 v{latest})\n"
                f"Update: cd ~/OpenJarvis && git pull && uv sync\033[0m\n\n"
            )
    except InvalidVersion:
        pass


def _get_latest_version(current: str) -> str | None:
    """Return latest version string from cache or GitHub API."""
    try:
        if _CACHE_PATH.exists():
            data = json.loads(_CACHE_PATH.read_text())
            last_check = data.get("last_check", 0)
            if time.time() - last_check < _CACHE_TTL:
                return data.get("latest_version")
    except Exception:
        pass

    try:
        import urllib.request

        req = urllib.request.Request(
            _GITHUB_API,
            headers={"Accept": "application/vnd.github.v3+json"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read())
            tag = data.get("tag_name", "")
            latest = tag.lstrip("v")
    except Exception:
        return None

    try:
        _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CACHE_PATH.write_text(
            json.dumps(
                {
                    "last_check": time.time(),
                    "latest_version": latest,
                    "current_version": current,
                }
            )
        )
    except Exception:
        pass

    return latest
