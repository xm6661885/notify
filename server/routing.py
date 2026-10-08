"""Pure topic and recipient selection rules."""
from __future__ import annotations

import re
from dataclasses import dataclass

TOPIC_RE = re.compile(r"(?<![\w/&#])#(\w[\w-]{0,63})")


@dataclass
class UserRouting:
    id: int
    disabled: bool
    topics_mode: str
    topics: list[str]
    blacklist: list[str]
    admin_blacklist: list[str]


def extract_topics(text: str | None) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    for match in TOPIC_RE.finditer(text or ""):
        display = match.group(1).rstrip("-")
        if not display:
            continue
        key = display.casefold()
        if key not in seen:
            seen.add(key)
            found.append((key, display))
    return found


def contains_keyword(text: str | None, keywords: list[str]) -> bool:
    folded = (text or "").casefold()
    return any(word.strip().casefold() in folded for word in keywords if word.strip())


def compute_recipients(
    text: str | None,
    file_name: str | None,
    topics: list[str],
    users: list[UserRouting],
    routes: dict[str, list[int]],
) -> list[int]:
    keys = {topic.lstrip("#").casefold() for topic in topics}
    routed_ids = {user_id for key in keys for user_id in routes.get(key, [])}
    routed = bool(routed_ids)
    search_text = "\n".join(value for value in (text, file_name) if value)
    result = []
    for user in users:
        if user.disabled or (routed and user.id not in routed_ids):
            continue
        if contains_keyword(search_text, user.blacklist + user.admin_blacklist):
            continue
        own_topics = {topic.lstrip("#").casefold() for topic in user.topics}
        if not routed and user.topics_mode == "only" and not keys.intersection(own_topics):
            continue
        result.append(user.id)
    return sorted(result)
