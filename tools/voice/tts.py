"""Windows SAPI 播报（SubStage 4.3 §4.3）。

零依赖：用 `subprocess.run` + list 参数调 PowerShell 的 `System.Speech`，**不拼 shell 命令**
（§8 明文禁止这条路）。文本按 PowerShell 单引号规则转义（`'` → `''`）后嵌入脚本，
因此用户说什么都不会变成命令。

失败语义（§4.3 / §5）：找不到 voice、非 Windows、超时、退出码非 0 → 打一行 warn 并返回 0，
**永不抛**；第一次失败后把 `tts_disabled` 置真，后续调用直接返回 0 不再起子进程
（避免每轮白等一次 PowerShell 启动）。

播报是**阻塞**的：`say()` 返回时声音已经放完——`pipeline.py` 的半双工（§4.5）正是靠这一点，
在 `say()` 期间不读麦克风。
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

__all__ = ["DEFAULT_VOICE", "Speaker", "build_script"]

DEFAULT_VOICE = 'Microsoft Huihui Desktop'
DEFAULT_TIMEOUT_S = 10.0

# 只有 Windows 有 CREATE_NO_WINDOW；其它平台取 0（`subprocess.run` 会忽略默认值之外的平台差异）。
_CREATE_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def build_script(text: str, voice: str = DEFAULT_VOICE) -> str:
    """PowerShell 脚本正文：选嗓音（失败就退回系统默认）后同步朗读 `text`。

    文本与嗓音名都走 `_ps_quote`：单引号串里 `'` 写成 `''`，PowerShell 不会把内容当代码。

    `Speak()` 失败时**必须让退出码非 0**：PowerShell 的 `-Command` 默认把异常当"非终止错误"
    写进 stderr 却仍然以 0 退出（实测低完整性进程里 SAPI 会报"系统上未安装语音，或没有当前
    安全设置可用的语音"），调用方会把"一句话都没念"当成播报成功。

    第一行的输出编码也是必须的：没有控制台（stdout 被重定向到管道/文件）时，PowerShell 按 OEM
    代码页写 stderr，Python 侧按 UTF-8 解就会得到一串乱码，warn 里看不到真实原因。
    """
    return (
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
        "$ErrorActionPreference = 'Stop'; "
        'Add-Type -AssemblyName System.Speech; '
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
        f'try {{ $s.SelectVoice({_ps_quote(voice)}) }} catch {{ }}; '
        f'try {{ $s.Speak({_ps_quote(text)}) }} '
        "catch { [Console]::Error.WriteLine('E_TTS: ' + $_.Exception.Message); $s.Dispose(); exit 3 }; "
        '$s.Dispose()'
    )


def _ps_quote(value: str) -> str:
    """PowerShell 单引号字面量（`'` → `''`，不做任何变量展开）。"""
    return "'" + str(value).replace("'", "''") + "'"


def _powershell_path() -> str:
    """优先用内置的 Windows PowerShell 5.1；找不到就退回 PATH 里的 `powershell`。"""
    system_root = os.environ.get('SystemRoot') or r'C:\Windows'
    exe = os.path.join(system_root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if os.path.isfile(exe):
        return exe
    return 'powershell'


class Speaker:
    """把一句话念出来，返回耗时毫秒；任何异常都吞成 warn（`say()` 的契约是"永不抛"）。"""

    def __init__(
        self,
        *,
        voice: str = DEFAULT_VOICE,
        enabled: bool = True,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        self.voice = voice
        self.enabled = bool(enabled)
        self.timeout_s = float(timeout_s)
        # 第一次失败后置真：不再起子进程，也不重复刷 warn（§4.3）
        self.tts_disabled = not self.enabled
        self.last_error: str | None = None
        self.calls = 0

    # -- 契约 ---------------------------------------------------------------

    def say(self, text: str) -> float:
        """朗读 `text`，返回耗时 ms；失败返回 0 且只 warn（永不抛）。"""
        if not self.enabled or self.tts_disabled:
            return 0.0
        if not isinstance(text, str) or not text.strip():
            return 0.0
        if os.name != 'nt':
            self._fail('非 Windows 平台没有 System.Speech')
            return 0.0

        command = [
            _powershell_path(),
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            build_script(text, self.voice),
        ]
        started = time.perf_counter()
        self.calls += 1
        try:
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=self.timeout_s,
                creationflags=_CREATE_NO_WINDOW,
            )
        except subprocess.TimeoutExpired:
            self._fail(f'播报超过 {self.timeout_s:.0f} s 没结束')
            return 0.0
        except OSError as exc:
            self._fail(f'起不动 PowerShell：{exc}')
            return 0.0
        except Exception as exc:  # noqa: BLE001 - 播报失败不许影响业务
            self._fail(f'播报异常：{exc}')
            return 0.0

        if proc.returncode != 0:
            detail = ((proc.stdout or '') + (proc.stderr or '')).strip().splitlines()
            self._fail(f'退出码 {proc.returncode}：{detail[-1] if detail else "无输出"}')
            return 0.0
        return round((time.perf_counter() - started) * 1000.0, 1)

    def close(self) -> None:
        """没有常驻资源；保留接口给调用方（幂等）。"""
        self.enabled = False if self.tts_disabled else self.enabled

    # -- 内部 ---------------------------------------------------------------

    def _fail(self, detail: str) -> None:
        self.tts_disabled = True
        self.last_error = detail
        print(f'[warn] 播报不可用（后续不再尝试）：{detail}', file=sys.stderr)
