"""SubStage 5.3 `llm` 模式：把 holdout 逐条喂给 `llm.PlanClient`，只测**模型**这一层。

为什么要有这个模式（与任务书 §4.2 的 `pipeline.py --text` 并存）
----------------------------------------------------------------
`pipeline.py` 的 `_dispatch()` 顺序是"规则层优先"：`parser.parse()` 命中就不调 LLM。
5.1 的 `verify.mjs` 要求"每条 holdout 都能被 `parser.py` 命中同一条 kb 条目"，
于是 holdout 上 `route=='rule'` 恒为真——用 pipeline 跑三档，量到的是**规则层**，不是模型。
本探针绕开规则层，直接用同一个 `PlanClient`（同 schema 约束解码、同本地校验、同提示词）
逐条出 L1，三档才有可比性。两条路的结果都进报告，口径差异写在 `mode` 字段里。

协议（NDJSON over stdin/stdout，行缓冲）
--------------------------------------
启动后先吐一行：

    {"type":"ready","promptMode":...,"fewshotCount":...,"systemSha256":...,"systemChars":...,"warmupMs":...}

之后每读一行 `{"id":"h000001","text":"高音少"}` 就吐一行：

    {"type":"row","id":...,"ok":true,"norm":"…","plan":{…}|null,"error":null,
     "llm_ms":1420.3,"prompt_n":12,"predicted_n":44,"cache_n":0}

退出码：0 正常 / 2 参数错 / 8 llama-server 不可用（契约沿用 `llm.LlmUnavailable` 的语义，
不从 0/2 之外再发明新码给验收用；run.mjs 看到 8 会按"这一档评测失败"处理）。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

_VOICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _VOICE_DIR not in sys.path:
    sys.path.insert(0, _VOICE_DIR)

import llm as llm_module  # noqa: E402  - SubStage 3.3
from normalize import normalize  # noqa: E402  - SubStage 2.2

DEFAULT_URL = 'http://127.0.0.1:8768'
EXIT_OK = 0
EXIT_ARGS = 2
EXIT_LLM_DOWN = 8


def _configure_stdio() -> None:
    for handle in (sys.stdout, sys.stderr):
        if hasattr(handle, 'reconfigure'):
            try:
                handle.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
            except (ValueError, OSError):
                pass


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def take_option(argv: list[str], name: str, default: str | None = None) -> tuple[list[str], str | None]:
    rest: list[str] = []
    value = default
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == name:
            if index + 1 >= len(argv):
                raise SystemExit(f'{name} 需要值')
            value = argv[index + 1]
            index += 2
            continue
        if arg.startswith(name + '='):
            value = arg[len(name) + 1:]
            index += 1
            continue
        rest.append(arg)
        index += 1
    return rest, value


def build_client(prompt_mode: str, url: str) -> llm_module.PlanClient:
    """与 `eval/prompt_shim.py` 同口径：`system` 档不拼 few-shot，其余用默认 5 条。"""

    client = llm_module.PlanClient(base_url=url)
    if prompt_mode == 'system':
        system_text = Path(client.system_prompt_path).read_text(encoding='utf-8')
        client.fewshots = []
        client.system_message = system_text
        client.system_sha256 = hashlib.sha256(system_text.encode('utf-8')).hexdigest()
    return client


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    raw = list(sys.argv[1:] if argv is None else argv)
    raw, prompt_mode = take_option(raw, '--eval-prompt', 'fewshot')
    raw, url = take_option(raw, '--url', DEFAULT_URL)
    warmup = '--warmup' in raw
    raw = [arg for arg in raw if arg != '--warmup']
    if raw:
        print(f'不认识的参数：{raw}', file=sys.stderr)
        return EXIT_ARGS
    if prompt_mode not in ('system', 'fewshot'):
        print(f'--eval-prompt 只能是 system|fewshot，收到 {prompt_mode}', file=sys.stderr)
        return EXIT_ARGS

    client = build_client(prompt_mode, url)
    warmup_ms = None
    if warmup:
        started = time.perf_counter()
        try:
            client.warmup()
        except llm_module.LlmUnavailable as exc:
            print(f'llama-server 不可用（{exc}）', file=sys.stderr)
            return EXIT_LLM_DOWN
        warmup_ms = round((time.perf_counter() - started) * 1000.0, 1)

    emit({
        'type': 'ready',
        'promptMode': prompt_mode,
        'fewshotCount': len(client.fewshots),
        'systemSha256': client.system_sha256,
        'systemChars': len(client.system_message),
        'warmupMs': warmup_ms,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({'type': 'row', 'id': None, 'ok': False, 'plan': None, 'error': f'E_BAD_REQUEST: {exc}'})
            continue
        row_id = request.get('id')
        text = request.get('text') or ''
        norm = normalize(text)
        started = time.perf_counter()
        plan = None
        error = None
        try:
            plan = client.plan(norm, state=None)
        except llm_module.LlmUnavailable as exc:
            error = f'E_LLM_UNAVAILABLE: {exc}'
        except Exception as exc:  # noqa: BLE001 - 单条失败不许带走整批
            error = f'E_PROBE: {exc}'
        elapsed_ms = round((time.perf_counter() - started) * 1000.0, 1)
        stats = client.last_stats
        if plan is None and error is None:
            # `plan()` 返回 None 但服务没报错：输出被截断/不是合法 JSON/未过本地校验
            error = 'E_INVALID'
        emit({
            'type': 'row',
            'id': row_id,
            'ok': plan is not None,
            'norm': norm,
            'plan': plan,
            'error': error,
            'llm_ms': elapsed_ms,
            'prompt_n': stats.prompt_n,
            'predicted_n': stats.predicted_n,
            'cache_n': stats.cache_n,
            'finish_reason': stats.finish_reason,
        })
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main())
