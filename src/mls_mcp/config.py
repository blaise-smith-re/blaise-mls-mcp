"""Configuration for the MLS MCP server.

All settings come from environment variables so that credentials are never
committed to the repository. MCP clients normally supply these through the
``env`` block of the server definition; for local development a ``.env`` file
in the working directory is also read (existing environment variables always
win).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Dict, Optional

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_PAGE_SIZE = 25
DEFAULT_MAX_PAGE_SIZE = 200
DEFAULT_USER_AGENT = "mls-mcp/0.1.0"


class AuthStyle(str, Enum):
    """How the access token is presented to the MLS feed."""

    BEARER = "bearer"
    """``Authorization: Bearer <token>`` — the RESO Web API standard."""

    QUERY_PARAM = "query_param"
    """``?access_token=<token>`` — used by some vendors (e.g. Bridge)."""

    NONE = "none"
    """No authentication; for public demo/reference servers."""


class ConfigError(RuntimeError):
    """Raised when the server is not configured well enough to run."""


def _load_dotenv(path: Path) -> None:
    """Populate ``os.environ`` from a ``.env`` file without overwriting."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _get_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc


def _get_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


def _get_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    """Resolved server configuration."""

    base_url: str
    token: Optional[str]
    auth_style: AuthStyle = AuthStyle.BEARER
    auth_query_param: str = "access_token"
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    max_page_size: int = DEFAULT_MAX_PAGE_SIZE
    default_page_size: int = DEFAULT_PAGE_SIZE
    user_agent: str = DEFAULT_USER_AGENT
    verify_ssl: bool = True
    extra_headers: Dict[str, str] = field(default_factory=dict)

    def auth_headers(self) -> Dict[str, str]:
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        headers.update(self.extra_headers)
        if self.auth_style is AuthStyle.BEARER and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def auth_params(self) -> Dict[str, str]:
        if self.auth_style is AuthStyle.QUERY_PARAM and self.token:
            return {self.auth_query_param: self.token}
        return {}


def load_settings(env: Optional[Dict[str, str]] = None) -> Settings:
    """Build :class:`Settings` from the environment.

    Args:
        env: Optional mapping used instead of ``os.environ`` (used by tests).

    Raises:
        ConfigError: If a required variable is missing or malformed.
    """
    if env is None:
        _load_dotenv(Path.cwd() / ".env")
        source = os.environ
    else:
        source = env
        os.environ.update(env)

    base_url = (source.get("MLS_API_BASE_URL") or "").strip()
    if not base_url:
        raise ConfigError(
            "MLS_API_BASE_URL is not set. Point it at the OData service root of "
            "your MLS feed, for example "
            "'https://api.bridgedataoutput.com/api/v2/OData/<dataset>'. "
            "See README.md for per-vendor examples."
        )
    if not base_url.startswith(("http://", "https://")):
        raise ConfigError(
            f"MLS_API_BASE_URL must start with http:// or https://, got {base_url!r}"
        )

    try:
        auth_style = AuthStyle((source.get("MLS_AUTH_STYLE") or "bearer").strip().lower())
    except ValueError as exc:
        valid = ", ".join(style.value for style in AuthStyle)
        raise ConfigError(
            f"MLS_AUTH_STYLE must be one of: {valid}. "
            f"Got {source.get('MLS_AUTH_STYLE')!r}"
        ) from exc

    token = (source.get("MLS_API_TOKEN") or "").strip() or None
    if auth_style is not AuthStyle.NONE and not token:
        raise ConfigError(
            "MLS_API_TOKEN is not set. Provide the access token issued by your MLS "
            "or data vendor, or set MLS_AUTH_STYLE=none for an unauthenticated "
            "demo feed."
        )

    max_page_size = _get_int("MLS_MAX_PAGE_SIZE", DEFAULT_MAX_PAGE_SIZE)
    if max_page_size < 1:
        raise ConfigError("MLS_MAX_PAGE_SIZE must be at least 1")

    default_page_size = min(_get_int("MLS_DEFAULT_PAGE_SIZE", DEFAULT_PAGE_SIZE), max_page_size)

    return Settings(
        base_url=base_url.rstrip("/"),
        token=token,
        auth_style=auth_style,
        auth_query_param=(source.get("MLS_AUTH_QUERY_PARAM") or "access_token").strip(),
        timeout_seconds=_get_float("MLS_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS),
        max_page_size=max_page_size,
        default_page_size=default_page_size,
        user_agent=(source.get("MLS_USER_AGENT") or DEFAULT_USER_AGENT).strip(),
        verify_ssl=_get_bool("MLS_VERIFY_SSL", True),
    )
