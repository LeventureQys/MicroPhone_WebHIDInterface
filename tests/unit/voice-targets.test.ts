import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PARAMS } from '../../src/renderer/src/domain/params';
import {
  CONDITIONAL_ACTIONS,
  DIMENSIONS,
  DIRECTIONS,
  STRENGTHS,
  TOGGLE_RULES,
  paramIdOfAction,
} from '../../tools/voice/contract/kb';
import {
  EQ_FIELDS,
  PARAM_IDS,
  TARGET_WRITABLE,
  TOGGLE_TARGETS,
  TUNE_TARGETS,
  isParamId,
} from '../../tools/voice/contract/targets';

/** 仓库根：从 cwd（vitest 在仓库根跑）向上找 `tools/voice/emit.mjs`，不依赖 import.meta.url 的 scheme */
function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, 'tools', 'voice', 'emit.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = resolveRepoRoot();

function scalarParamIds(): string[] {
  return PARAMS.filter((param) => !param.readonly).map((param) => param.id);
}

function eqParamIds(): string[] {
  const ids: string[] = [];
  for (let band = 1; band <= 7; band += 1) {
    for (const field of EQ_FIELDS) ids.push(`eq.band${band}.${field}`);
  }
  return ids;
}

describe('targets.ts 白名单投影', () => {
  it('5. PARAM_IDS 与 PARAMS 的非只读项顺序一致、只读项不在其中', () => {
    const scalars = scalarParamIds();
    expect(scalars).toHaveLength(44);
    expect(PARAMS).toHaveLength(46);
    expect(eqParamIds()).toHaveLength(28);
    // 顺序 = 可写标量（PARAMS 顺序）+ 28 个 EQ 字段
    expect(PARAM_IDS).toEqual([...scalars, ...eqParamIds()]);
    // 72 = 44 个可写标量 + 28 个 EQ 字段。
    // 设计文档 §3.2 写的是"46 个标量 + 28 = 74"，那处把只读的 gain.Mic / gain.Hp 也计入；
    // 但寄存器表里这两项是 access:'r'，问题清单 D7 与设计文档 §3.3 的 excluded 层都要求不可写，
    // 所以白名单是 72（见 SubStage 3.1 完成报告的"与任务书不一致处"）。
    expect(PARAM_IDS).toHaveLength(72);
    for (const readonlyParam of PARAMS.filter((param) => param.readonly).map((param) => param.id)) {
      expect(PARAM_IDS).not.toContain(readonlyParam);
    }
    expect(PARAM_IDS.filter((param) => param === 'gain.Mic' || param === 'gain.Hp')).toEqual([]);
    // 白名单里没有重复项
    expect(new Set(PARAM_IDS).size).toBe(PARAM_IDS.length);
    expect(isParamId('eq.band1.type')).toBe(true);
    expect(isParamId('gain.Mic')).toBe(false);
  });

  it('6. TARGET_WRITABLE 的每个 id ⊆ PARAM_IDS，且与 rules 实际用到的 id 一致', () => {
    expect(Object.keys(TARGET_WRITABLE).sort()).toEqual(
      [...new Set([...TUNE_TARGETS, ...TOGGLE_TARGETS])].sort(),
    );
    for (const [target, ids] of Object.entries(TARGET_WRITABLE)) {
      for (const id of ids) {
        expect(isParamId(id), `${target} 的 writable 含白名单外的 ${id}`).toBe(true);
      }
      expect(ids.length, `${target} 的 writable 为空`).toBeGreaterThan(0);
    }
    // 每个维度：writable === 该维度 rules ∪ 开关动作 ∪ 条件动作 实际用到的 id
    for (const dimension of DIMENSIONS) {
      const used = new Set<string>();
      for (const direction of DIRECTIONS) {
        for (const strength of STRENGTHS) {
          for (const action of dimension.rules[direction][strength]) used.add(paramIdOfAction(action));
        }
      }
      const toggle = TOGGLE_RULES[dimension.id as keyof typeof TOGGLE_RULES];
      if (toggle) {
        for (const action of [...toggle.on, ...toggle.off]) used.add(paramIdOfAction(action));
      }
      for (const conditional of CONDITIONAL_ACTIONS) {
        if (conditional.target !== dimension.id) continue;
        for (const action of conditional.then) used.add(paramIdOfAction(action));
      }
      expect(dimension.writable, `${dimension.id} 的 writable 与 rules 不一致`).toEqual(
        [...used].sort(),
      );
      expect(TARGET_WRITABLE[dimension.id], `${dimension.id} 的 TARGET_WRITABLE 与 writable 不一致`).toEqual(
        dimension.writable,
      );
    }
    // 只有开关没有调参的目标（mute / monitor）也要在表里
    expect(TARGET_WRITABLE.mute).toEqual(['mic.mute']);
    expect(TARGET_WRITABLE.monitor).toEqual(['hp.OnOff']);
    // 调参与开关同名的目标取并集（例：gate 既要写门限也要写使能位）
    expect(TARGET_WRITABLE.gate).toEqual(['noisegate.Enable', 'noisegate.threshold_db']);
  });

  it('10. emit --check 在当前仓库退出码 0（生成物与 kb 一致）', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '--import',
        pathToFileURL(path.join(REPO_ROOT, 'tools', 'voice', 'register-loader.mjs')).href,
        // 入口脚本要传普通路径：Node 的 main 解析不认 file: URL（--import 才认）
        path.join(REPO_ROOT, 'tools', 'voice', 'emit.mjs'),
        '--check',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(result.stderr, `emit --check 输出：${result.stderr}`).not.toContain('Error');
    expect(result.status, `emit --check 输出：${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('4 个生成物与 kb 一致');
  });
});
