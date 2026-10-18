# SubStage 4.2 — 集成、启动测试与取证

- 所属 Stage：Stage 4
- 依赖前置：SubStage 1.1、2.1–2.3、3.1–3.4、4.1 全部完成
- 并行状态：串行（最后一道）
- 所属阶段：阶段三 - 开发

## 1. 背景与目标

把各 SubStage 的零件接成一个能跑的应用，跑通启动测试与截图取证，产出完成报告。集成期发现的接口偏差由本 SubStage 就地修正（限接线层），业务缺陷上报主 Agent。

## 2. 交付内容

| 项 | 内容 |
|---|---|
| `src/renderer/src/main.ts` | 最终装配：样式导入 → `MockTransport` → `AppStore` → 六个视图 → `router` → `createShell` → 挂载 → 暴露 `window.__micstudioGo` |
| `src/renderer/src/device/protocol.ts` | 收尾：常量 + 占位类型 + 联调 TODO 注释 |
| `tests/unit/integration.test.ts` | 装配级测试：构造 store + transport + shell，断言 6 个路由可切换、无异常 |
| `artifacts/` | 6 张截图 + `startup.log` + `test.log` + `build.log` |
| `Document/Update/Alpha/v1.0.0/完成报告-阶段三.md` | 完成报告（含证据） |

## 3. 装配契约

```ts
// src/renderer/src/main.ts
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

const transport = new MockTransport({ scene: 'speech' });
const store = new AppStore(transport, { lang: currentLang() });
await transport.open();

const views = {
  meter:    () => createMeterView(store, transport),
  input:    () => createInputView(store),
  eq:       () => createEqView(store),
  dynamics: () => createDynamicsView(store),
  drc:      () => createDrcView(store),
  settings: () => createSettingsView(store),
};

const mount = document.getElementById('app')!;
const router = createRouter({ mount: document.createElement('div'), store, views }); // mount 由 shell 提供
const shell = createShell({ store, router });
mount.appendChild(shell);

(window as any).__micstudioGo = (r: string) => store.setModule(r as never);
```

`createShell` 需要负责把 `router` 挂到 `#view-root`：若 `createRouter` 的 `mount` 参数与 shell 内部节点冲突，以 shell 为准（shell 内部创建 router 时可传入已存在的 `#view-root`）。实现顺序建议：

1. 先创建 `#view-root` 所在的 shell 骨架（不含 router 调用）。
2. 把 `#view-root` 交给 `createRouter`。
3. `router.go(store.get().module)` 完成首屏。

`index.html` 的 `#app` 容器必须 `height: 100%`。

## 4. 集成检查清单（逐条执行并记录）

1. 六个视图都能挂载，切页 3 轮无异常。
2. 参数改动会进 `MockTransport.writtenBuffer()`（在控制台 `transport.writtenBuffer().length` 可见增长）。
3. 语言切换后：顶栏、导轨、所有卡片标题、控件标签、EQ 列表全部切换，无残留中英混排。
4. EQ 拖动时曲线重算无明显卡顿（拖动 3 秒内帧率 ≥ 30fps，可用 `performance` 采样）。
5. 电平数值与柱体一致（RMS 数值与柱体位置对应）。
6. 窗口缩放到 1100×700 时无横向滚动条、EQ 画布随之缩放。

## 5. 启动测试与取证（必须真实执行）

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

& $node $pnpm run build      | Tee-Object artifacts/build.log
& $node $pnpm run test       | Tee-Object artifacts/test.log
& $node $pnpm run screenshot
```

启动打包产物（先 `pnpm run dist:win`）：

```powershell
$env:MICSTUDIO_USER_DATA = 'D:\WorkShop\MicroPhone_WebHIDInterface\.userdata'
Start-Process 'release\win-unpacked\MicStudio.exe' -PassThru
# 观察 15 秒后检查进程存活、截图 artifacts/startup-packaged.png
```

注意：本机沙箱环境中，未设置 `MICSTUDIO_USER_DATA` 时 Electron 主进程会崩溃（0xC0000005），这不是产品缺陷。

## 6. 完成报告必须包含

1. 每个 SubStage 的落地文件清单（相对路径）。
2. `build.log` / `test.log` 的关键输出片段（构建耗时、用例数、通过数）。
3. 6 张截图的路径与一句话说明（哪张证明了什么）。
4. 启动测试记录：命令、等待时长、进程是否存活、窗口标题、关键日志行。
5. 打包产物路径与体积。
6. 未验证 / 被阻塞项清单（macOS、Linux、真实 HID、代码签名）。
7. 与设计文档的偏差清单（若有）。

## 7. 禁止事项

- 不得用"看起来正常"替代证据。
- 不得跳过截图或启动测试直接报完成。
- 不得为了让测试通过而删除测试用例。
- 不得修改 `Document/Protocol/` 与需求文档。

## 8. 错误处理契约

- 单测失败：定位到具体 SubStage 文件修复；同一失败最多重试 3 次，仍失败上报主 Agent 重规划。
- 截图出现白屏：先看 `artifacts/startup.log` 与渲染端 console 转发；白屏通常意味着 JS 抛错或样式未加载。
- 打包超时（网络）：确认两个镜像环境变量，重试一次；仍失败记录到 `artifacts/dist-failure.log` 并上报。

## 9. 依赖前置

需等待 4.1 完成。无并行。
