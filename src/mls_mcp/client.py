"""Async HTTP client for RESO Web API (OData v4) MLS feeds."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import httpx

from .config import Settings
from .errors import MLSError, translate_http_error

logger = logging.getLogger("mls_mcp.client")

RETRY_STATUSES = {429, 500, 502, 503, 504}
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 1.0


@dataclass
class ODataPage:
    """One page of an OData collection response."""

    records: List[Dict[str, Any]] = field(default_factory=list)
    total_count: Optional[int] = None
    next_link: Optional[str] = None

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "ODataPage":
        value = payload.get("value")
        if value is None:
            # A single-entity response has no "value" envelope.
            value = [payload] if payload else []
        if not isinstance(value, list):
            raise MLSError(
                "MLS feed returned an unexpected response shape.",
                hint="Expected an OData collection with a 'value' array.",
            )
        count = payload.get("@odata.count")
        return cls(
            records=[record for record in value if isinstance(record, dict)],
            total_count=int(count) if isinstance(count, (int, str)) and str(count).isdigit() else None,
            next_link=payload.get("@odata.nextLink"),
        )


class ResoClient:
    """Thin, retrying wrapper around a RESO Web API endpoint.

    One instance is shared for the lifetime of the server so that connections
    are pooled across tool calls.
    """

    def __init__(self, settings: Settings, client: Optional[httpx.AsyncClient] = None) -> None:
        self._settings = settings
        self._client = client
        self._lock = asyncio.Lock()

    @property
    def settings(self) -> Settings:
        return self._settings

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            async with self._lock:
                if self._client is None:
                    self._client = httpx.AsyncClient(
                        timeout=self._settings.timeout_seconds,
                        verify=self._settings.verify_ssl,
                        follow_redirects=True,
                    )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _url_for(self, resource: str) -> str:
        return f"{self._settings.base_url}/{resource.lstrip('/')}"

    async def _request(
        self,
        url: str,
        params: Optional[Dict[str, str]] = None,
        *,
        accept: str = "application/json",
    ) -> httpx.Response:
        """Issue a GET with retries on transient failures."""
        client = await self._get_client()
        headers = dict(self._settings.auth_headers())
        headers["Accept"] = accept
        merged_params: Dict[str, str] = dict(self._settings.auth_params())
        if params:
            merged_params.update(params)

        last_exc: Optional[Exception] = None
        for attempt in range(MAX_RETRIES):
            try:
                response = await client.get(url, params=merged_params or None, headers=headers)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_exc = exc
                if attempt == MAX_RETRIES - 1:
                    raise
                await asyncio.sleep(BACKOFF_BASE_SECONDS * (2**attempt))
                continue

            if response.status_code in RETRY_STATUSES and attempt < MAX_RETRIES - 1:
                delay = _retry_after_seconds(response) or BACKOFF_BASE_SECONDS * (2**attempt)
                logger.warning(
                    "MLS feed returned %s; retrying in %.1fs", response.status_code, delay
                )
                await asyncio.sleep(delay)
                continue

            if response.is_error:
                raise translate_http_error(
                    httpx.HTTPStatusError(
                        f"HTTP {response.status_code}", request=response.request, response=response
                    )
                )
            return response

        raise MLSError(  # pragma: no cover - unreachable while MAX_RETRIES > 0
            f"MLS request failed after {MAX_RETRIES} attempts: {last_exc}"
        )

    async def get_collection(
        self, resource: str, params: Optional[Dict[str, str]] = None
    ) -> ODataPage:
        """Fetch one page of an OData collection, e.g. ``Property``."""
        response = await self._request(self._url_for(resource), params)
        return ODataPage.from_payload(_json_of(response))

    async def get_entity(
        self, resource: str, key: str, params: Optional[Dict[str, str]] = None
    ) -> Optional[Dict[str, Any]]:
        """Fetch a single record by key, e.g. ``Property('12345')``."""
        from .odata import quote_literal  # local import avoids a cycle at import time

        url = self._url_for(f"{resource}({quote_literal(key)})")
        response = await self._request(url, params)
        payload = _json_of(response)
        return payload if isinstance(payload, dict) and payload else None

    async def get_page_by_url(self, url: str) -> ODataPage:
        """Follow an ``@odata.nextLink`` returned by the feed."""
        response = await self._request(url)
        return ODataPage.from_payload(_json_of(response))

    async def collect(
        self,
        resource: str,
        params: Optional[Dict[str, str]] = None,
        *,
        max_records: int = 200,
        max_pages: int = 10,
    ) -> ODataPage:
        """Fetch up to ``max_records`` records, following ``@odata.nextLink``.

        Used by the analytics tools (comparables, market statistics), which need
        a full result set rather than a single page. Bounded on both records and
        pages so a broad filter cannot run away.
        """
        page = await self.get_collection(resource, params)
        records = list(page.records)
        next_link = page.next_link
        pages = 1

        while next_link and len(records) < max_records and pages < max_pages:
            following = await self.get_page_by_url(next_link)
            if not following.records:
                break
            records.extend(following.records)
            next_link = following.next_link
            pages += 1

        return ODataPage(
            records=records[:max_records],
            total_count=page.total_count,
            next_link=next_link,
        )

    async def get_metadata(self) -> str:
        """Fetch the raw ``$metadata`` CSDL document as XML text."""
        response = await self._request(
            self._url_for("$metadata"), accept="application/xml"
        )
        return response.text


def _retry_after_seconds(response: httpx.Response) -> Optional[float]:
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return max(0.0, min(float(raw), 30.0))
    except ValueError:
        return None


def _json_of(response: httpx.Response) -> Dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise MLSError(
            "MLS feed returned a non-JSON response.",
            hint=(
                "Confirm MLS_API_BASE_URL points at the OData service root "
                "(the path that serves $metadata), not an HTML portal page."
            ),
        ) from exc
    if not isinstance(payload, dict):
        raise MLSError("MLS feed returned an unexpected JSON payload (not an object).")
    return payload
