"""Background-thread launcher for roundtable sessions.

Why in-process thread (not subprocess like agent-run.sh):
  - Roundtable is pure HTTP egress to LLM endpoints, no shell side effects,
    no need for the process isolation agent-run.sh provides.
  - 9 LLM calls × ~5-15s each = 45-135s typical. Threads are fine for this
    duration; FastAPI's other endpoints stay responsive (the HTTP calls
    release the GIL while waiting on the network).
  - Persistence is incremental (append_turn after every call), so even if
    the thread is killed mid-session, the jsonl up to the last completed
    turn is still valid and readable.

The PWA polls GET /roundtables/{id} every ~2s to show progress.
"""
from __future__ import annotations

import dataclasses
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Optional

from .. import config
from . import roles as roles_mod
from . import role_models_store
from .data import Role, Session
from .debate import run_session, continue_session
from .io import session_path_for, write_error_marker, write_meta
from .model import ModelError, call_model


OnCompleteFn = Callable[[Path], None]
"""Callback signature: receives the session jsonl path. Fired EXACTLY ONCE
per submit() call, regardless of success/failure — the caller is expected
to re-read the jsonl to decide what happened (look for type='synth' = done,
role='__error__' = failed). Kept narrow so we don't leak Session internals
to subscribers (e.g. the Feishu adapter)."""


def _customize_role(role: Role) -> Role:
    """用 persistent override 替换 role.system_prompt;若无 override 返回
    原 role(身份不变 — 性能 + 语义双优化)。model 不在这里 customize —
    用现有的 role_models_overrides dict 路径解决。"""
    override_prompt = role_models_store.load().get(role.name, {}).get("system_prompt")
    if override_prompt:
        return dataclasses.replace(role, system_prompt=override_prompt)
    return role


def _customized_role_list() -> tuple[list[Role], Role, Role]:
    """构造一组 customized roles(ROLES + SYNTHESIZER + REVIEWER)。
    返回 (roles, synthesizer, reviewer) 三元组,给 _execute / _execute_continue 用。"""
    return (
        [_customize_role(r) for r in roles_mod.ROLES],
        _customize_role(roles_mod.SYNTHESIZER),
        _customize_role(roles_mod.REVIEWER),
    )


def submit(
    question: str,
    *,
    role_models: dict[str, str] | None = None,
    critique_rounds: int = 1,
    enable_decider: bool = False,
    on_complete: Optional[OnCompleteFn] = None,
) -> Path:
    """Kick off a roundtable session in a background thread.

    role_models: optional per-role model override. Map role name → model
    name. Caller (main.py) is responsible for validating against
    MODEL_ENDPOINTS — we just pass through.

    critique_rounds: 1 (default) or 2. See debate.run_session docstring.
    Caller is responsible for clamping — we just pass through.

    on_complete: optional callback fired when the worker thread finishes
    (success or failure). Receives the session_path.

    NB: callbacks DON'T survive backend restart. If the worker thread is
    killed mid-debate, no callback fires. jsonl is still the source of
    truth — callback is just opportunistic push.

    Returns the session_path. Caller can derive the id via path.stem.
    """
    started_at = time.time()
    sessions_dir = config.ROUNDTABLES_DIR
    sessions_dir.mkdir(parents=True, exist_ok=True)
    path = session_path_for(question, started_at, sessions_dir)
    # Write meta synchronously so GET /roundtables/{id} can find the row
    # immediately, before the worker thread has progressed at all.
    write_meta(path, Session(
        question=question,
        started_at=started_at,
        critique_rounds=critique_rounds,
        decider_enabled=enable_decider,
    ))

    t = threading.Thread(
        target=_execute,
        args=(question, path, dict(role_models or {}), critique_rounds,
              enable_decider, on_complete),
        name=f"roundtable-{path.stem}",
        daemon=True,
    )
    t.start()
    return path


def _execute(
    question: str,
    session_path: Path,
    role_models: dict[str, str],
    critique_rounds: int,
    enable_decider: bool,
    on_complete: Optional[OnCompleteFn],
) -> None:
    """Run the debate end-to-end. Any error is written to the session
    jsonl as a synthetic __error__ turn so the PWA can show it.

    on_complete fires in a `finally` — so subscribers see both happy and
    sad paths, and a broken callback can't poison the next session (we
    swallow its exceptions: it's an opportunistic push, failures shouldn't
    cascade)."""
    try:
        from . import decider as decider_mod
        roles, synthesizer, reviewer = _customized_role_list()
        decider = _customize_role(decider_mod.DECIDER) if enable_decider else None
        run_session(
            question=question,
            roles=roles,
            synthesizer=synthesizer,
            model_fn=call_model,
            session_path=session_path,
            role_model_overrides=role_models,
            critique_rounds=critique_rounds,
            reviewer=reviewer,
            decider=decider,
            mode="roundtable",
        )
    except ModelError as e:
        # Expected failure mode (provider down, rate limit exhausted,
        # placeholder API key, etc.). Surface to the user via the jsonl.
        write_error_marker(session_path, f"model error: {type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001 — last-ditch, never lose the error
        write_error_marker(session_path, f"unexpected: {type(e).__name__}: {e}")
    finally:
        if on_complete is not None:
            try:
                on_complete(session_path)
            except Exception:    # noqa: BLE001 — broken callback must not poison the thread
                pass


def submit_oneonone(
    question: str,
    *,
    stance_a: str,
    stance_b: str,
    role_models: dict[str, str] | None = None,
    enable_decider: bool = False,
    on_complete: Optional[OnCompleteFn] = None,
) -> Path:
    """跟 submit() 同形,但跑 1v1 对抗 mode:

    - ROLES = [正方, 反方](由 oneonone.make_proponent_roles 构造,立场字符串
      注入同一 PROPONENT_PROMPT_TEMPLATE)
    - critique_rounds=2(R1 陈述 + R2 反驳)
    - max_auto_drills=0(spec Q6:1v1 不接 reviewer drill)
    - Session.mode="oneonone" 标识

    user 在 #settings/roles 给"正方"/"反方"override 的 system_prompt 也会
    被 _customize_role 应用(跟 4 派同款路径)。
    """
    started_at = time.time()
    sessions_dir = config.ROUNDTABLES_DIR
    sessions_dir.mkdir(parents=True, exist_ok=True)
    path = session_path_for(question, started_at, sessions_dir)
    write_meta(path, Session(
        question=question,
        started_at=started_at,
        critique_rounds=2,
        mode="oneonone",
        decider_enabled=enable_decider,
    ))

    t = threading.Thread(
        target=_execute_oneonone,
        args=(question, stance_a, stance_b, path,
              dict(role_models or {}), enable_decider, on_complete),
        name=f"oneonone-{path.stem}",
        daemon=True,
    )
    t.start()
    return path


def _execute_oneonone(
    question: str,
    stance_a: str,
    stance_b: str,
    session_path: Path,
    role_models: dict[str, str],
    enable_decider: bool,
    on_complete: Optional[OnCompleteFn],
) -> None:
    """1v1 调试 worker。跟 _execute 同款错误处理 — ModelError → __error__ 行,
    其它 exception 兜底,on_complete 在 finally 中始终触发。"""
    try:
        from . import oneonone        # 局部 import 避免 module-level 循环
        # 1v1 角色 customization 走专门路径:不能像 4 派那样 _customize_role
        # 替换 system_prompt — 因为 PROPONENT prompt 含 {stance}/{opponent_stance}
        # 等占位符,format 必须在 customization 内一次完成。
        # 用户在 #settings/roles 改了"正方"/"反方"的 system_prompt 时,
        # override 作为 template 传给 make_proponent_roles,后者校验占位符 +
        # 一次性 format,不 silent loss。
        overrides = role_models_store.load()
        template_a = overrides.get("正方", {}).get("system_prompt") or oneonone.PROPONENT_PROMPT_TEMPLATE
        template_b = overrides.get("反方", {}).get("system_prompt") or oneonone.PROPONENT_PROMPT_TEMPLATE
        proponents = oneonone.make_proponent_roles(
            stance_a, stance_b, template_a=template_a, template_b=template_b,
        )
        # 整理员仍走标准 _customize_role 路径(无占位符,override 直接生效)
        from . import decider as decider_mod
        synthesizer = _customize_role(roles_mod.SYNTHESIZER)
        decider = _customize_role(decider_mod.DECIDER) if enable_decider else None
        run_session(
            question=question,
            roles=proponents,
            synthesizer=synthesizer,
            model_fn=call_model,
            session_path=session_path,
            role_model_overrides=role_models,
            critique_rounds=2,
            max_auto_drills=0,    # 1v1 不接 reviewer drill(spec Q6)
            reviewer=None,         # max_auto_drills=0 → reviewer 不会被 invoke
            decider=decider,
            mode="oneonone",
        )
    except ModelError as e:
        write_error_marker(session_path, f"model error: {type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001
        write_error_marker(session_path, f"unexpected: {type(e).__name__}: {e}")
    finally:
        if on_complete is not None:
            try:
                on_complete(session_path)
            except Exception:    # noqa: BLE001
                pass


def submit_continue(
    session_path: Path,
    follow_up_question: str,
    *,
    role_models: dict[str, str] | None = None,
    on_complete: Optional[OnCompleteFn] = None,
) -> None:
    """跟 submit 同模式 — 在 background thread 里跑 continue_session。"""
    t = threading.Thread(
        target=_execute_continue,
        args=(session_path, follow_up_question, dict(role_models or {}), on_complete),
        name=f"roundtable-continue-{session_path.stem}",
        daemon=True,
    )
    t.start()


def _execute_continue(
    session_path: Path,
    follow_up_question: str,
    role_models: dict[str, str],
    on_complete: Optional[OnCompleteFn],
) -> None:
    """在 background thread 里跑 continue_session。错误写入 jsonl 的 __error__ turn。"""
    try:
        roles, synthesizer, reviewer = _customized_role_list()
        continue_session(
            session_path=session_path,
            follow_up_question=follow_up_question,
            roles=roles,
            synthesizer=synthesizer,
            model_fn=call_model,
            role_model_overrides=role_models,
            reviewer=reviewer,
        )
    except ModelError as e:
        write_error_marker(session_path, f"model error during continue: {type(e).__name__}: {e}")
    except Exception as e:    # noqa: BLE001
        write_error_marker(session_path, f"unexpected during continue: {type(e).__name__}: {e}")
    finally:
        if on_complete is not None:
            try:
                on_complete(session_path)
            except Exception:  # noqa: BLE001
                pass
