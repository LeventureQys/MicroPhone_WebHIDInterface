"""SubStage 5.3：评测用的 `pipeline.py` 入口（**不改** `pipeline.py` / `llm.py`）。

为什么需要这一层
----------------
`pipeline.py` 里写的是 `llm_module.PlanClient(base_url=...)`，提示词路径全用默认值，
没有命令行开关能换 system 消息；而任务书的三档定义要求 `base` 档是"不带 few-shot（纯 system）"。
本文件在 import 之后替换 `llm.PlanClient`（`pipeline` 在**调用时**取 `llm_module.PlanClient`，
所以替换会生效），再原样调用 `pipeline.main()`：

    python tools/voice/eval/prompt_shim.py --eval-prompt system --text "高音少" --sink dry --no-tts

- `--eval-prompt fewshot`：与直接跑 `pipeline.py` **逐字节相同**（只加一行 stderr 自述）；
- `--eval-prompt system`：system 消息 = `prompts/system.zh.txt` 全文，不拼 few-shot。

退出码与 `pipeline.py` 完全一致（本文件不新增任何退出码）。
stdout 仍只有一行 JSON（`pipeline.py` 的约定），自述走 stderr：

    [eval-shim] promptMode=system fewshots=0 systemSha256=<前16位> systemChars=<n>
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

_VOICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _VOICE_DIR not in sys.path:
    sys.path.insert(0, _VOICE_DIR)

import llm as llm_module  # noqa: E402  - SubStage 3.3
import pipeline  # noqa: E402  - SubStage 4.3

PROMPT_MODES = ('system', 'fewshot')
DEFAULT_PROMPT_MODE = 'fewshot'


def _configure_stdio() -> None:
    for handle in (sys.stdout, sys.stderr):
        if hasattr(handle, 'reconfigure'):
            try:
                handle.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
            except (ValueError, OSError):
                pass


def take_option(argv: list[str], name: str, default: str | None = None) -> tuple[list[str], str | None]:
    """把 `--name value` / `--name=value` 从 argv 里摘出来（其余原样留给 pipeline.py）。"""

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


def make_client_class(prompt_mode: str):
    """生成一个只换 system 消息的 `PlanClient` 子类（其余行为继承，避免复制逻辑）。"""

    class EvalPlanClient(llm_module.PlanClient):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):  # noqa: ANN002, ANN003 - 透传给父类
            super().__init__(*args, **kwargs)
            self.prompt_mode = prompt_mode
            if prompt_mode == 'system':
                # 任务书三档定义：base 档"不带 few-shot（纯 system）"——不拼"参考示例"抬头
                system_text = Path(self.system_prompt_path).read_text(encoding='utf-8')
                self.fewshots = []
                self.system_message = system_text
                self.system_sha256 = hashlib.sha256(system_text.encode('utf-8')).hexdigest()

    return EvalPlanClient


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    raw = list(sys.argv[1:] if argv is None else argv)
    rest, prompt_mode = take_option(raw, '--eval-prompt', DEFAULT_PROMPT_MODE)
    if prompt_mode not in PROMPT_MODES:
        print(f'--eval-prompt 只能是 {"|".join(PROMPT_MODES)}，收到 {prompt_mode}', file=sys.stderr)
        return pipeline.EXIT_ARGS

    llm_module.PlanClient = make_client_class(prompt_mode)
    # pipeline.prepare_llm 里还会用 llm_module.LlmUnavailable，保持模块本身不变即可
    probe = make_client_class(prompt_mode)  # 只为打印自述，不发起请求
    try:
        described = probe(base_url='http://127.0.0.1:9')  # 端口不监听无所谓：构造不发请求
        print(
            f'[eval-shim] promptMode={prompt_mode} fewshots={len(described.fewshots)} '
            f'systemSha256={described.system_sha256[:16]} systemChars={len(described.system_message)}',
            file=sys.stderr,
        )
    except Exception as exc:  # noqa: BLE001 - 自述失败不该拦住评测
        print(f'[eval-shim] 提示词自述失败（不影响评测）：{exc}', file=sys.stderr)

    return pipeline.main(rest)


if __name__ == '__main__':
    sys.exit(main())
