import { beforeEach, describe, expect, it } from 'vitest';
import type { FirmwareState } from '../../src/renderer/src/device/dfu/controller';
import type { DfuInfo } from '../../src/renderer/src/device/dfu/image';
import { setLang, t } from '../../src/renderer/src/i18n';
import { createFirmwareView, type FirmwareSource } from '../../src/renderer/src/ui/views/firmware-view';

const INFO: DfuInfo = {
  modelCode: 'JYM001',
  modelName: 'MIC M001',
  version: { x: 1, y: 2, z: 3 },
  length: 21_824,
  checksum: 0x4e0621af,
};

const IDLE: FirmwareState = {
  phase: 'idle',
  progress: null,
  error: null,
  info: null,
  confirmed: false,
  fileName: null,
};

class FakeController implements FirmwareSource {
  readonly selectCalls: File[] = [];
  startCalls = 0;
  replugCalls = 0;
  acceptSelect = true;

  private current: FirmwareState = { ...IDLE };
  private readonly listeners = new Set<(state: FirmwareState) => void>();

  state(): FirmwareState {
    return this.current;
  }

  onChange(cb: (state: FirmwareState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async selectFile(file: File): Promise<{ readonly ok: true; readonly blocks: number } | { readonly ok: false; readonly message: string }> {
    this.selectCalls.push(file);
    if (!this.acceptSelect) {
      this.push({ phase: 'failed' });
      return { ok: false, message: 'fw.error.noDevice' };
    }
    this.push({ phase: 'ready', fileName: file.name, info: INFO, confirmed: false });
    return { ok: true, blocks: 4 };
  }

  setConfirmed(confirmed: boolean): void {
    this.push({ confirmed });
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async replugAndRetry(): Promise<void> {
    this.replugCalls += 1;
  }

  /** 测试用：直接推进状态并广播（等价于真实控制器的 patch） */
  push(partial: Partial<FirmwareState>): void {
    this.current = { ...this.current, ...partial };
    for (const cb of [...this.listeners]) cb(this.current);
  }
}

function mount(controller: FakeController): { root: HTMLElement; view: HTMLElement } {
  const view = createFirmwareView({ controller });
  const root = document.createElement('div');
  root.append(view);
  document.body.append(root);
  return { root, view };
}

function pickFile(root: HTMLElement, name = 'app-1.2.3.bin'): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('file input missing');
  const file = new File([new Uint8Array(64)], name, { type: 'application/octet-stream' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  return input;
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('firmware view', () => {
  beforeEach(() => {
    setLang('zh');
    document.body.innerHTML = '';
  });

  it('1. 未选文件时开始按钮 disabled 且提示未选包', () => {
    const controller = new FakeController();
    const { root } = mount(controller);
    expect(root.querySelector<HTMLButtonElement>('.fw-start')?.disabled).toBe(true);
    expect(root.querySelector('.fw-file-name')?.textContent).toBe(t('fw.file.none'));
    expect(root.querySelector<HTMLElement>('.fw-info')?.hidden).toBe(true);
  });

  it('2. 选文件后预检摘要渲染型号 / 长度 / 块数', async () => {
    const controller = new FakeController();
    const { root } = mount(controller);
    pickFile(root);
    await settle();

    expect(controller.selectCalls).toHaveLength(1);
    const value = (field: string): string | null | undefined =>
      root.querySelector<HTMLElement>(`[data-field="${field}"]`)?.textContent;
    expect(value('model')).toBe('JYM001');
    expect(value('version')).toBe('1.2.3');
    expect(value('length')).toBe('21824 B');
    expect(value('blocks')).toBe('4');
    expect(value('checksum')).toBe('0x4E0621AF');
    expect(root.querySelector<HTMLElement>('.fw-info')?.hidden).toBe(false);
    expect(root.querySelector('.fw-file-name')?.textContent).toBe('app-1.2.3.bin');
  });

  it('3. 未勾选确认时开始按钮 disabled，勾选后 enabled', async () => {
    const controller = new FakeController();
    const { root } = mount(controller);
    pickFile(root);
    await settle();
    const start = root.querySelector<HTMLButtonElement>('.fw-start');
    expect(start?.disabled).toBe(true);

    const confirm = root.querySelector<HTMLInputElement>('.fw-confirm input[type="checkbox"]');
    if (confirm === null) throw new Error('confirm checkbox missing');
    confirm.checked = true;
    confirm.dispatchEvent(new Event('change'));
    expect(start?.disabled).toBe(false);
    expect(controller.state().confirmed).toBe(true);
  });

  it('4. phase=writing 时进度文本含 块 3/4', async () => {
    const controller = new FakeController();
    const { root } = mount(controller);
    pickFile(root);
    await settle();
    controller.push({
      phase: 'writing',
      progress: {
        phase: 'writing',
        blockIndex: 2,
        blockTotal: 4,
        percent: 60,
        round: 1,
        message: 'fw.phase.writing',
      },
    });

    expect(root.querySelector<HTMLElement>('.fw-progress')?.hidden).toBe(false);
    expect(root.querySelector('.fw-block')?.textContent).toBe('块 3/4');
    expect(root.querySelector('.fw-phase')?.textContent).toBe(t('fw.phase.writing'));
    expect(root.querySelector('.fw-percent')?.textContent).toContain('60');
    expect(root.querySelector<HTMLProgressElement>('.fw-bar')?.value).toBe(60);
  });

  it('5. phase=done 时显示新版本且关闭按钮可用', async () => {
    const controller = new FakeController();
    const { root } = mount(controller);
    pickFile(root);
    await settle();
    controller.push({
      phase: 'done',
      progress: {
        phase: 'done',
        blockIndex: 3,
        blockTotal: 4,
        percent: 100,
        round: 1,
        message: 'fw.phase.done',
      },
    });

    expect(root.querySelector<HTMLElement>('.fw-result')?.hidden).toBe(false);
    expect(root.querySelector('.fw-done')?.textContent).toBe(t('fw.done.version', { version: '1.2.3' }));
    expect(root.querySelector<HTMLButtonElement>('.fw-close')?.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('.fw-retry')?.hidden).toBe(true);
  });

  it('6. destroy() 后不再响应 controller 事件', async () => {
    const controller = new FakeController();
    const { root, view } = mount(controller);
    pickFile(root);
    await settle();
    const before = root.querySelector('.fw-file-name')?.textContent;
    (view as HTMLElement & { destroy?: () => void }).destroy?.();

    controller.push({
      phase: 'writing',
      fileName: 'other.bin',
      progress: { phase: 'writing', blockIndex: 0, blockTotal: 9, percent: 10, round: 1, message: 'fw.phase.writing' },
    });
    expect(root.querySelector('.fw-file-name')?.textContent).toBe(before);
    expect(root.querySelector<HTMLElement>('.fw-progress')?.hidden).toBe(true);
  });

  it('6b. 预检失败时显示返回的文案键，且不画预检摘要', async () => {
    const controller = new FakeController();
    controller.acceptSelect = false;
    const { root } = mount(controller);
    pickFile(root, 'bootld.bin');
    await settle();

    expect(root.querySelector<HTMLElement>('.fw-error')?.hidden).toBe(false);
    expect(root.querySelector('.fw-error-title')?.textContent).toBe(t('fw.error.noDevice'));
    expect(root.querySelector<HTMLElement>('.fw-info')?.hidden).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.fw-start')?.disabled).toBe(true);
  });
});
