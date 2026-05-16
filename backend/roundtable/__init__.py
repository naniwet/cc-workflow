"""Multi-agent roundtable — third PWA tab.

Ported from https://github.com/<owner>/AgentRoundtable (~/work/workspace/
AgentRoundtable as of 2026-05-14). The IP is roles.py — 4 finely-tuned
Chinese personas + a synthesizer. The orchestration (debate.py / synth.py /
io.py / data.py) is mechanical glue, adapted from the original near-verbatim.

Differences from the upstream CLI tool:
  - LLM client: stdlib urllib (no openai SDK dep) — see model.py.
  - Storage:   ~/.cc-state/roundtables/<slug>.jsonl (was ./sessions/<slug>.jsonl)
  - Endpoint config: providers.json#openai_endpoints (was env vars
    DEEPSEEK_API_KEY / MOONSHOT_API_KEY)
  - Execution: in-process background thread (see runner.py),
    NOT subprocess like agent-run.sh, since the roundtable is pure HTTP
    egress with no shell side effects.
  - No render.py (no static HTML) — PWA renders natively.

If you upgrade the upstream AgentRoundtable prompts (roles.py),
re-copy them verbatim. Don't translate, don't "clean up" — the Chinese
guardrails are finely tuned for DeepSeek's response patterns.
"""
