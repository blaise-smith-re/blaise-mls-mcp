"""Error types and agent-facing error formatting."""

from __future__ import annotations

from typing import Optional

import httpx

from .odata import ODataError


class MLSError(RuntimeError):
    """An error worth reporting back to the calling agent verbatim."""

    def __init__(self, message: str, *, hint: Optional[str] = None) -> None:
        super().__init__(message)
        self.hint = hint

    def __str__(self) -> str:  # pragma: no cover - trivial
        base = super().__str__()
        return f"{base} {self.hint}" if self.hint else base


class AuthenticationError(MLSError):
    """The feed rejected our credentials."""


class NotFoundError(MLSError):
    """The requested record or resource does not exist on this feed."""


class RateLimitError(MLSError):
    """The feed is throttling us."""


def _body_excerpt(response: httpx.Response, limit: int = 300) -> str:
    """Return a short, safe excerpt of an error body for diagnostics."""
    try:
        text = response.text
    except Exception:  # pragma: no cover - defensive
        return ""
    text = " ".join(text.split())
    if not text:
        return ""
    return text[:limit] + ("..." if len(text) > limit else "")


def translate_http_error(exc: httpx.HTTPStatusError) -> MLSError:
    """Convert an HTTP failure into an actionable MLS error.

    The messages name the likely cause and the next step, because the caller is
    an agent that has to decide what to try next without seeing the raw
    response.
    """
    status = exc.response.status_code
    detail = _body_excerpt(exc.response)
    suffix = f" Feed said: {detail}" if detail else ""

    if status in (401, 403):
        return AuthenticationError(
            f"MLS feed rejected the credentials (HTTP {status}).",
            hint=(
                "Check MLS_API_TOKEN is current and MLS_AUTH_STYLE matches your "
                "vendor ('bearer' for standard RESO, 'query_param' for feeds that "
                "expect ?access_token=). Some feeds also scope tokens per dataset."
                + suffix
            ),
        )
    if status == 404:
        return NotFoundError(
            "MLS feed returned 404 for that request.",
            hint=(
                "Either the record key does not exist, or the resource name is not "
                "offered by this feed. Call mls_describe_metadata to list the "
                "resources and fields this feed actually exposes." + suffix
            ),
        )
    if status == 429:
        return RateLimitError(
            "MLS feed rate limit exceeded (HTTP 429).",
            hint=(
                "Wait before retrying, and reduce 'limit' or narrow the filter to "
                "fetch fewer records per call." + suffix
            ),
        )
    if status == 400:
        return MLSError(
            "MLS feed rejected the query as malformed (HTTP 400).",
            hint=(
                "This usually means a field in the filter, $select or $orderby does "
                "not exist on this feed, or the feed does not support that operator. "
                "Call mls_describe_metadata to confirm field names." + suffix
            ),
        )
    if status == 501:
        return MLSError(
            "MLS feed does not implement that query option (HTTP 501).",
            hint=(
                "Try removing $count, $orderby or $expand — support for these is "
                "optional in the RESO Web API Core spec." + suffix
            ),
        )
    if 500 <= status < 600:
        return MLSError(
            f"MLS feed returned a server error (HTTP {status}).",
            hint="This is on the feed's side. Retry shortly." + suffix,
        )
    return MLSError(f"MLS request failed with HTTP {status}.", hint=suffix.strip() or None)


def format_error(exc: Exception) -> str:
    """Render any exception as a single-line, agent-readable error string."""
    if isinstance(exc, ODataError):
        return f"Error: {exc}"
    if isinstance(exc, MLSError):
        return f"Error: {exc}"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"Error: {translate_http_error(exc)}"
    if isinstance(exc, httpx.TimeoutException):
        return (
            "Error: The MLS feed timed out. Narrow the filter or lower 'limit', "
            "then retry. Raise MLS_TIMEOUT_SECONDS if large queries are expected."
        )
    if isinstance(exc, httpx.RequestError):
        return (
            f"Error: Could not reach the MLS feed ({type(exc).__name__}). "
            "Check MLS_API_BASE_URL and network connectivity."
        )
    return f"Error: Unexpected {type(exc).__name__}: {exc}"
