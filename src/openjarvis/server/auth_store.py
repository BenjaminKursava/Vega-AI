"""SQLite-backed local user accounts for the OpenJarvis server.

Accounts live on this machine only, in ``~/.openjarvis/users.db``. Nothing
in this module talks to the network: there is no remote identity provider,
no analytics hook, and no third-party call. A sign-up never leaves the box.

Passwords are stored as PBKDF2-HMAC-SHA256 digests with a per-user random
salt — never in plain text, and never recoverable. A forgotten password
means creating a new account or deleting the row.
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# PBKDF2 work factor: high enough that a stolen users.db is expensive to
# crack offline, low enough that sign-in still feels instant.
_PBKDF2_ITERATIONS = 240_000
_SALT_BYTES = 16
_SESSION_TTL_SECONDS = 30 * 24 * 3600  # 30 days

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 256  # bound the KDF input; PBKDF2 cost scales with it
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class AuthError(Exception):
    """A recoverable auth failure — bad input, duplicate email, etc."""


def _hash_password(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations
    )


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


class AuthStore:
    """Local account store. One SQLite file, no network."""

    def __init__(self, db_path: str = "") -> None:
        if not db_path:
            db_path = str(Path.home() / ".openjarvis" / "users.db")

        from openjarvis.security.file_utils import secure_create

        # 0o600 — the file holds password digests, so keep it owner-only.
        secure_create(Path(db_path))
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # FastAPI runs sync handlers on a threadpool, so concurrent writes
        # are possible even though this is a single-user desktop app.
        self._lock = threading.Lock()
        self._create_tables()

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def _create_tables(self) -> None:
        with self._lock:
            self._db.executescript(
                """\
                CREATE TABLE IF NOT EXISTS users (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    email         TEXT    NOT NULL,
                    display_name  TEXT    NOT NULL DEFAULT '',
                    password_hash BLOB    NOT NULL,
                    salt          BLOB    NOT NULL,
                    iterations    INTEGER NOT NULL,
                    created_at    REAL    NOT NULL,
                    last_login_at REAL
                );
                -- NOCASE so Foo@x.com and foo@x.com cannot both register.
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
                    ON users (email COLLATE NOCASE);

                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token      TEXT    PRIMARY KEY,
                    user_id    INTEGER NOT NULL,
                    created_at REAL    NOT NULL,
                    expires_at REAL    NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_user
                    ON auth_sessions (user_id);
                """
            )
            self._db.commit()

    # ------------------------------------------------------------------
    # Users
    # ------------------------------------------------------------------

    def user_count(self) -> int:
        row = self._db.execute("SELECT COUNT(*) AS n FROM users").fetchone()
        return int(row["n"]) if row else 0

    @staticmethod
    def _public(row: sqlite3.Row) -> Dict[str, Any]:
        """Shape a user row for the API — never includes hash or salt."""
        return {
            "id": row["id"],
            "email": row["email"],
            "display_name": row["display_name"],
            "created_at": row["created_at"],
        }

    def create_user(
        self, email: str, password: str, display_name: str = ""
    ) -> Dict[str, Any]:
        email = _normalize_email(email)
        if not _EMAIL_RE.match(email):
            raise AuthError("Please enter a valid email address.")
        if len(password or "") < MIN_PASSWORD_LENGTH:
            raise AuthError(
                f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
            )
        if len(password) > MAX_PASSWORD_LENGTH:
            raise AuthError(
                f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
            )

        salt = secrets.token_bytes(_SALT_BYTES)
        digest = _hash_password(password, salt, _PBKDF2_ITERATIONS)
        now = time.time()

        with self._lock:
            try:
                cur = self._db.execute(
                    "INSERT INTO users"
                    " (email, display_name, password_hash, salt, iterations, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        email,
                        (display_name or "").strip(),
                        digest,
                        salt,
                        _PBKDF2_ITERATIONS,
                        now,
                    ),
                )
                self._db.commit()
            except sqlite3.IntegrityError as exc:
                raise AuthError("An account with that email already exists.") from exc
            user_id = cur.lastrowid

        row = self._db.execute(
            "SELECT * FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        return self._public(row)

    def verify_credentials(self, email: str, password: str) -> Optional[Dict[str, Any]]:
        """Return the user on a correct password, else ``None``."""
        email = _normalize_email(email)
        row = self._db.execute(
            "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email,)
        ).fetchone()

        if row is None:
            # Spend comparable time on a miss so response latency does not
            # reveal whether an email is registered.
            _hash_password(password or "", b"\x00" * _SALT_BYTES, _PBKDF2_ITERATIONS)
            return None

        expected = row["password_hash"]
        actual = _hash_password(password or "", row["salt"], int(row["iterations"]))
        if not secrets.compare_digest(bytes(expected), actual):
            return None

        with self._lock:
            self._db.execute(
                "UPDATE users SET last_login_at = ? WHERE id = ?",
                (time.time(), row["id"]),
            )
            self._db.commit()
        return self._public(row)

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT INTO auth_sessions (token, user_id, created_at, expires_at)"
                " VALUES (?, ?, ?, ?)",
                (token, user_id, now, now + _SESSION_TTL_SECONDS),
            )
            self._db.execute(
                "DELETE FROM auth_sessions WHERE expires_at < ?", (now,)
            )
            self._db.commit()
        return token

    def user_for_token(self, token: str) -> Optional[Dict[str, Any]]:
        if not token:
            return None
        row = self._db.execute(
            "SELECT u.* FROM auth_sessions s"
            " JOIN users u ON u.id = s.user_id"
            " WHERE s.token = ? AND s.expires_at > ?",
            (token, time.time()),
        ).fetchone()
        return self._public(row) if row else None

    def delete_session(self, token: str) -> None:
        if not token:
            return
        with self._lock:
            self._db.execute("DELETE FROM auth_sessions WHERE token = ?", (token,))
            self._db.commit()

    def close(self) -> None:
        try:
            self._db.close()
        except Exception:
            logger.debug("AuthStore close failed", exc_info=True)


_store: Optional[AuthStore] = None
_store_lock = threading.Lock()


def get_auth_store() -> AuthStore:
    """Process-wide AuthStore singleton, created on first use."""
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = AuthStore()
    return _store


__all__ = [
    "AuthError",
    "AuthStore",
    "MIN_PASSWORD_LENGTH",
    "get_auth_store",
]
