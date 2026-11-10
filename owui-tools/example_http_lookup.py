"""
title: Example HTTP lookup
description: Template for an Open WebUI custom tool written outside the UI. Copy it, rename it, and keep the docstring style.
required_open_webui_version: 0.6.0
requirements: httpx
"""

import httpx
from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        base_url: str = Field("https://example.com", description="Upstream endpoint")
        timeout: float = Field(15.0, description="Request timeout in seconds")
        max_chars: int = Field(4000, description="Maximum characters returned to the model")

    def __init__(self):
        self.valves = self.Valves()

    async def lookup(self, path: str) -> str:
        """
        Fetch a path from the configured endpoint and return its text.

        Use this when the user asks for data that upstream holds and the chat has no
        other source for it.

        :param path: Path appended to the configured base URL, for example "/status".
        :return: Response body, truncated to the configured limit, or an error message.
        """
        url = f"{self.valves.base_url.rstrip('/')}/{path.lstrip('/')}"
        try:
            async with httpx.AsyncClient(timeout=self.valves.timeout) as client:
                response = await client.get(url)
                response.raise_for_status()
                return response.text[: self.valves.max_chars]
        except httpx.HTTPStatusError as error:
            return f"Upstream returned {error.response.status_code} for {url}"
        except Exception as error:  # noqa: BLE001 - a tool must never raise into the chat
            return f"Lookup failed for {url}: {error}"
