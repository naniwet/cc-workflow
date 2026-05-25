"""Persistent per-role model overrides.

Schema (~/.cc-workflow/role_models.json):
    {"<role-name>": "<model-name>", ...}

空 dict / 缺 key / unknown role / unknown model 一律 fall through 到
role.preferred_model(hardcode in roles.py)。validation 在 main.py
API surface 做(PUT endpoint 校验 model 在 MODEL_ENDPOINTS 里),
这里是纯 read/write。

跟 backend/ws_settings.py 一样的容错策略:文件读不出 → {} + warning,
启动失败比降级危险。spec §3.1。
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from .. import config

_logger = logging.getLogger(__name__)

_PATH = config.CCW_DIR / "role_models.json"


def load() -> dict[str, str]:
    """Return the full overrides dict; {} when file missing / unreadable."""
    if not _PATH.exists():
        return {}
    try:
        data = json.loads(_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            _logger.warning("role_models.json 不是 dict,忽略: %r", data)
            return {}
        return {str(k): str(v) for k, v in data.items()}
    except (OSError, json.JSONDecodeError) as e:
        _logger.warning("role_models.json 读不出 (%s),fallback {}", e)
        return {}


def save(data: dict[str, str]) -> None:
    """Atomic write — temp + os.replace 防 race。"""
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _PATH)


def effective_model_for(role_name: str, hardcoded_default: str) -> str:
    """Persistent override > hardcoded_default。"""
    return load().get(role_name) or hardcoded_default
