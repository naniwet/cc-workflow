"""IM-agnostic card model (P0-5a, Phase 2 / T+2.5d).

Backend emits abstract Cards; each chat-adapter module renders them to its
own native JSON. This file MUST stay IM-neutral — A0'.7.

Contents:
    Section / Button / FormField / Card    frozen value-object dataclasses
    CardAction                             button-callback event
    sessions_card / loops_card / run_form_card    factories over db + cron_state
    register_refresh / regenerate          in-memory refresh-token map

refresh_token map is process-local. Backend restart drops it; users re-issue
the slash command to get a fresh card. Cheaper than a new SQLite table.
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional

from . import config

# ---------- value objects ----------

SectionKind = Literal["text", "kv", "table", "divider", "code"]
FieldKind = Literal["text", "textarea", "dropdown"]


@dataclass(frozen=True)
class Section:
    """content schema by kind:  text/code → str | kv → dict | table → list[list[str]] (header first) | divider → None"""
    kind: SectionKind
    content: Any = None


@dataclass(frozen=True)
class Button:
    label: str
    action: str                            # e.g. "refresh_card" / "pause_loop"
    params: dict = field(default_factory=dict)


@dataclass(frozen=True)
class FormField:
    name: str
    label: str
    kind: FieldKind = "text"
    options: tuple = ()                    # ("workspace-a", "workspace-b") for dropdown
    default: str = ""


@dataclass(frozen=True)
class Card:
    title: str
    sections: tuple = ()                   # tuple[Section, ...]
    buttons: tuple = ()                    # tuple[Button, ...]
    fields: tuple = ()                     # tuple[FormField, ...]  (for forms)
    refresh_token: Optional[str] = None    # set by factories that want a refresh button
    footer: str = ""


@dataclass(frozen=True)
class CardAction:
    """A button callback parsed back from any IM adapter."""
    action: str
    params: dict
    chat_id: str = ""
    user_id: str = ""


# ---------- refresh-token registry (in-memory, FIFO-evicted) ----------

_refresh_lock = threading.Lock()
_refresh_map: "dict[str, Callable[[], Card]]" = {}
_MAX_TOKENS = 100


def register_refresh(factory: Callable[[], Card]) -> str:
    """Stash a factory under a fresh token; return token (short hex)."""
    token = uuid.uuid4().hex[:12]
    with _refresh_lock:
        if len(_refresh_map) >= _MAX_TOKENS:
            _refresh_map.pop(next(iter(_refresh_map)))    # FIFO evict
        _refresh_map[token] = factory
    return token


def regenerate(token: str) -> Optional[Card]:
    """Look up the factory and re-run it; None if token unknown or evicted."""
    with _refresh_lock:
        factory = _refresh_map.get(token)
    return factory() if factory else None


# ---------- factories: data → Card ----------


def sessions_card() -> Card:
    """Active / queued / recent task list — refreshable."""
    from . import db                       # lazy: avoid import cycle at module load
    view = db.list_sessions_view()
    sections: list[Section] = []
    for key in ("active", "queued", "recent"):
        rows = (view.get(key) or [])[:10]
        sections.append(Section(kind="text", content=f"**{key}** ({len(rows)})"))
        if not rows:
            sections.append(Section(kind="text", content="_(none)_"))
            continue
        table = [["id", "workspace", "engine", "sk", "status", "elapsed"]] + [
            [
                (r.get("id") or "")[:12],
                r.get("workspace") or "-",
                r.get("engine") or "-",
                r.get("session_key") or "-",
                r.get("status") or "?",
                f"{r.get('elapsed_s')}s" if r.get("elapsed_s") is not None else "-",
            ]
            for r in rows
        ]
        sections.append(Section(kind="table", content=table))
        sections.append(Section(kind="divider"))

    token = register_refresh(sessions_card)
    return Card(
        title="Sessions",
        sections=tuple(sections),
        buttons=(Button(label="Refresh", action="refresh_card", params={"token": token}),),
        refresh_token=token,
    )


def loops_card() -> Card:
    """Cron loops list — each loop gets a pause / resume button."""
    from . import cron_state               # lazy
    jobs = cron_state.list_jobs()

    sections: list[Section] = []
    if not jobs:
        sections.append(Section(kind="text", content="_(no cron loops configured)_"))
    else:
        table = [["name", "enabled", "last_exit", "consec_err", "total_runs"]]
        for j in jobs:
            table.append([
                j.get("name", "") or "-",
                "✓" if j.get("enabled") else "✗",
                str(j.get("last_exit") if j.get("last_exit") is not None else "-"),
                str(j.get("consecutive_errors") or 0),
                str(j.get("total_runs") or 0),
            ])
        sections.append(Section(kind="table", content=table))

    buttons: list[Button] = []
    for j in jobs:
        name = j.get("name", "")
        if not name:
            continue
        if j.get("enabled"):
            buttons.append(Button(label=f"Pause {name}", action="pause_loop", params={"name": name}))
        else:
            buttons.append(Button(label=f"Resume {name}", action="resume_loop", params={"name": name}))

    token = register_refresh(loops_card)
    buttons.append(Button(label="Refresh", action="refresh_card", params={"token": token}))
    return Card(
        title="Loops",
        sections=tuple(sections),
        buttons=tuple(buttons),
        refresh_token=token,
    )


def run_form_card(workspaces: "list[str] | None" = None) -> Card:
    """New-task form: workspace dropdown + prompt textarea + Run button."""
    if workspaces is None:
        workspaces = _discover_workspaces()
    fields = (
        FormField(
            name="workspace",
            label="Workspace",
            kind="dropdown",
            options=tuple(workspaces),
            default=workspaces[0] if workspaces else "",
        ),
        FormField(name="prompt", label="Prompt", kind="textarea"),
    )
    return Card(
        title="New Task",
        fields=fields,
        buttons=(Button(label="Run", action="submit_run", params={}),),
    )


def _discover_workspaces() -> "list[str]":
    """Sorted names of ~/workspaces/* that look like git repos."""
    try:
        return sorted(
            p.name
            for p in config.WORKSPACES_DIR.iterdir()
            if p.is_dir() and (p / ".git").exists() and not p.name.startswith(".")
        )
    except OSError:
        return []
