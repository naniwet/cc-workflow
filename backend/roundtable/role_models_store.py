"""Persistent per-role overrides(model + system_prompt;temperature 未来扩)。

Schema(~/.cc-workflow/role_models.json):
    {
      "<role-name>": {
        "model": "<model-name>",            # optional
        "system_prompt": "<prompt-text>",   # optional
      },
      ...
    }

老 flat dict 格式(`{role: model}` 只 model 一个)load 时自动升级到 nested,
但不写回文件 — 等用户下次 save 才落新格式(避免 load 副作用)。文件名保留
`role_models.json` 不改 — 跟 spec §2.3 的"几乎不可逆"决策对齐。

跟 backend/ws_settings.py 一样的容错策略:文件读不出 → {} + warning,
启动失败比降级危险。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from .. import config

_logger = logging.getLogger(__name__)

_PATH = config.CCW_DIR / "role_models.json"

# 接受的内层字段白名单 — 未知 key 在 load() 阶段过滤
_KNOWN_FIELDS = ("model", "system_prompt")


def _read_raw() -> dict:
    """读 JSON 文件,返回顶层 dict;{} on missing / unreadable / non-dict。"""
    if not _PATH.exists():
        return {}
    try:
        data = json.loads(_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            _logger.warning("role_models.json 不是 dict,忽略: %r", data)
            return {}
        return data
    except (OSError, json.JSONDecodeError) as e:
        _logger.warning("role_models.json 读不出 (%s),fallback {}", e)
        return {}


def load() -> dict[str, dict]:
    """Return overrides dict;always nested shape {role: {model?, system_prompt?}}。
    老 flat string value 自动升级到 {"model": value};未知 key 过滤;空 entry 丢。"""
    raw = _read_raw()
    out: dict[str, dict] = {}
    for role_name, val in raw.items():
        if isinstance(val, str):
            if val:
                out[role_name] = {"model": val}
        elif isinstance(val, dict):
            cleaned: dict[str, str] = {}
            for field in _KNOWN_FIELDS:
                v = val.get(field)
                if isinstance(v, str) and v:
                    cleaned[field] = v
            if cleaned:
                out[role_name] = cleaned
    return out


def save(data: dict[str, dict]) -> None:
    """Atomic write — temp + os.replace 防 race。
    Caller 已经传 nested 格式;这里不做 schema 升级 / 验证(那是 endpoint 的事)。"""
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _PATH)


def effective_model_for(role_name: str, hardcoded_default: str) -> str:
    """Persistent override > hardcoded_default。"""
    return load().get(role_name, {}).get("model") or hardcoded_default


def effective_system_prompt_for(role_name: str, hardcoded_default: str) -> str:
    """Persistent override > hardcoded_default。"""
    return load().get(role_name, {}).get("system_prompt") or hardcoded_default
