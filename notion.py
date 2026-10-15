"""Notion API bilan ishlash uchun kichik async klient."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import httpx

API_URL = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


@dataclass
class Task:
    id: str
    title: str
    status: str | None
    due: date | None
    url: str


class NotionError(Exception):
    pass


class Notion:
    def __init__(self, token: str, database_id: str, prop_status: str,
                 prop_assignee: str, prop_due: str, status_done: str):
        self.database_id = database_id.replace("-", "")
        self.prop_status = prop_status
        self.prop_assignee = prop_assignee
        self.prop_due = prop_due
        self.status_done = status_done
        self._client = httpx.AsyncClient(
            base_url=API_URL,
            timeout=30,
            headers={
                "Authorization": f"Bearer {token}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
        )
        # Baza sxemasidan aniqlanadi (load_schema)
        self.prop_title: str = "Name"
        self.status_type: str = "status"  # "status" yoki "select"
        self.status_options: list[str] = []

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        resp = await self._client.request(method, path, **kwargs)
        if resp.status_code >= 400:
            try:
                msg = resp.json().get("message", resp.text)
            except ValueError:
                msg = resp.text
            raise NotionError(f"Notion {resp.status_code}: {msg}")
        return resp.json()

    async def close(self) -> None:
        await self._client.aclose()

    async def load_schema(self) -> None:
        db = await self._request("GET", f"/databases/{self.database_id}")
        props = db["properties"]
        for name, prop in props.items():
            if prop["type"] == "title":
                self.prop_title = name
        for name in (self.prop_status, self.prop_assignee, self.prop_due):
            if name not in props:
                raise NotionError(
                    f"Bazada '{name}' ustuni topilmadi. Mavjud ustunlar: "
                    + ", ".join(props)
                )
        status = props[self.prop_status]
        self.status_type = status["type"]
        if self.status_type not in ("status", "select"):
            raise NotionError(f"'{self.prop_status}' ustuni status yoki select bo'lishi kerak")
        self.status_options = [o["name"] for o in status[self.status_type]["options"]]

    def _parse(self, page: dict) -> Task:
        props = page["properties"]
        title = "".join(t["plain_text"] for t in props[self.prop_title]["title"]) or "(nomsiz)"
        status_val = props.get(self.prop_status, {}).get(self.status_type)
        due_val = props.get(self.prop_due, {}).get("date")
        due = date.fromisoformat(due_val["start"][:10]) if due_val else None
        return Task(
            id=page["id"].replace("-", ""),
            title=title,
            status=status_val["name"] if status_val else None,
            due=due,
            url=page["url"],
        )

    async def my_tasks(self, user_id: str, include_done: bool = False) -> list[Task]:
        conditions = [{"property": self.prop_assignee, "people": {"contains": user_id}}]
        if not include_done:
            conditions.append({
                "property": self.prop_status,
                self.status_type: {"does_not_equal": self.status_done},
            })
        body: dict = {
            "filter": {"and": conditions},
            "sorts": [{"property": self.prop_due, "direction": "ascending"}],
            "page_size": 100,
        }
        tasks: list[Task] = []
        while True:
            data = await self._request("POST", f"/databases/{self.database_id}/query", json=body)
            tasks.extend(self._parse(p) for p in data["results"])
            if not data.get("has_more"):
                return tasks
            body["start_cursor"] = data["next_cursor"]

    async def get_task(self, page_id: str) -> Task:
        return self._parse(await self._request("GET", f"/pages/{page_id}"))

    async def set_status(self, page_id: str, status: str) -> Task:
        page = await self._request("PATCH", f"/pages/{page_id}", json={
            "properties": {self.prop_status: {self.status_type: {"name": status}}}
        })
        return self._parse(page)

    async def set_due(self, page_id: str, due: date | None) -> Task:
        value = {"start": due.isoformat()} if due else None
        page = await self._request("PATCH", f"/pages/{page_id}", json={
            "properties": {self.prop_due: {"date": value}}
        })
        return self._parse(page)

    async def create_task(self, title: str, user_id: str, due: date | None = None) -> Task:
        props: dict = {
            self.prop_title: {"title": [{"text": {"content": title}}]},
            self.prop_assignee: {"people": [{"id": user_id}]},
        }
        if self.status_options:
            props[self.prop_status] = {self.status_type: {"name": self.status_options[0]}}
        if due:
            props[self.prop_due] = {"date": {"start": due.isoformat()}}
        page = await self._request("POST", "/pages", json={
            "parent": {"database_id": self.database_id},
            "properties": props,
        })
        return self._parse(page)

    async def add_comment(self, page_id: str, text: str) -> None:
        await self._request("POST", "/comments", json={
            "parent": {"page_id": page_id},
            "rich_text": [{"text": {"content": text}}],
        })

    async def list_users(self) -> list[dict]:
        data = await self._request("GET", "/users", params={"page_size": 100})
        return [u for u in data["results"] if u["type"] == "person"]
