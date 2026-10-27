// 第三轮真机联调 · 应用级连续 sync 竞态与自检复跑（对应已知坑 26：0x12 轮询应答被 0x13 认领）。
//   electron.exe . --screenshot=artifacts\real4\app-race.png --route=device --exec-file=scripts\probes\real4-app-race.js --no-sandbox
(async () => {
  const out = { steps: [] };
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    const steps = () =>
      Array.from(document.querySelectorAll('.diag-selfcheck-steps > *')).map((node) => node.textContent?.replace(/\s+/g, ' ').trim());
    const stats = () => Object.fromEntries(Array.from(document.querySelectorAll('[data-stat]')).map((node) => [node.dataset.stat, node.textContent]));

    window.__micstudioGo('device');
    await wait(300);
    document.querySelector('.segmented .seg-btn[data-value="native"]')?.click();
    await wait(200);
    document.querySelector('.device-actions .btn')?.click();
    await wait(1500);
    const target = Array.from(document.querySelectorAll('.device-row')).find((row) => (row.textContent ?? '').includes('0A67'));
    if (!target) return JSON.stringify({ ...out, error: '设备列表里没有 0A67' });
    target.querySelector('.btn')?.click();
    await wait(4500);
    out.steps.push({ step: '连接完成', sourcePill: text('#source-pill'), syncPill: text('#sync-pill'), stats: stats() });

    for (let round = 1; round <= 3; round += 1) {
      document.querySelector('.diag-selfcheck')?.click();
      await wait(4500);
      out.steps.push({ step: `自检第 ${round} 轮`, syncPill: text('#sync-pill'), selfCheck: steps(), stats: stats() });
    }

    // 连续 sync（关掉再开设备，触发第二次 sync，间隔刻意压短）
    const row = Array.from(document.querySelectorAll('.device-row')).find((item) => (item.textContent ?? '').includes('0A67'));

    // 场景写入（设备仍在连接）→ 写入后再跑一次自检（自检第一步就是 sync）
    document.querySelector('.modal-close')?.click();
    await wait(300);
    document.querySelector('.scene-btn[data-scene="meeting"]')?.click();
    await wait(1500);
    window.__micstudioGo('device');
    await wait(600);
    document.querySelector('.diag-selfcheck')?.click();
    await wait(4500);
    out.steps.push({ step: '场景写入后自检（sync + 回读）', syncPill: text('#sync-pill'), selfCheck: steps(), stats: stats() });

    // 关掉设备，改用原始 HID 读回设备侧真值（0x2000 起 118 项）
    row?.querySelector('.btn')?.click();
    await wait(1200);
    out.afterClose = { sourcePill: text('#source-pill'), syncPill: text('#sync-pill') };

    const device = (await navigator.hid.getDevices()).find((item) => item.vendorId === 0x0a67 && item.productId === 0x0010);
    if (device) {
      if (!device.opened) await device.open();
      let reports = [];
      const onReport = (event) => reports.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
      device.addEventListener('inputreport', onReport);
      for (let chunk = 0; chunk < 2; chunk += 1) {
        const start = 0x2000 + chunk * 60;
        const count = chunk === 0 ? 60 : 58;
        const data = Uint8Array.from([(start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff]);
        const len = data.length + 6;
        const frame = new Uint8Array(len);
        frame[1] = 0x13;
        frame[2] = (len >>> 8) & 0xff;
        frame[3] = len & 0xff;
        frame.set(data, 4);
        let crc = 0xffff;
        for (let index = 0; index < len - 2; index += 1) {
          crc ^= frame[index];
          for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
        }
        frame[len - 2] = crc & 0xff;
        frame[len - 1] = (crc >>> 8) & 0xff;
        for (let offset = 0; offset < frame.length; offset += 63) {
          const report = new Uint8Array(63);
          report.set(frame.subarray(offset, Math.min(offset + 63, frame.length)));
          await device.sendReport(0x51, report);
        }
        await wait(400);
      }
      device.removeEventListener('inputreport', onReport);
      const merged = new Uint8Array(reports.reduce((sum, item) => sum + item.length, 0));
      let cursor = 0;
      for (const item of reports) {
        merged.set(item, cursor);
        cursor += item.length;
      }
      // 只解 0x13 长帧
      const words = {};
      let offset = 0;
      while (offset < merged.length) {
        while (offset + 1 < merged.length && merged[offset] === 0 && merged[offset + 1] === 0) offset += 1;
        if (merged.length - offset < 4) break;
        const len = (merged[offset + 2] << 8) | merged[offset + 3];
        if (len < 6 || len > 512 || len > merged.length - offset) {
          offset += 1;
          continue;
        }
        let crc = 0xffff;
        for (let index = offset; index < offset + len - 2; index += 1) {
          crc ^= merged[index];
          for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
        }
        const received = merged[offset + len - 2] | (merged[offset + len - 1] << 8);
        if (crc === received && merged[offset + 1] === 0x13) {
          const base = (merged[offset + 4] << 8) | merged[offset + 5];
          const total = (merged[offset + 6] << 8) | merged[offset + 7];
          for (let index = 0; index < total; index += 1) {
            const at = offset + 8 + index * 2;
            words[base + index] = (merged[at] << 8) | merged[at + 1];
          }
          offset += len;
          continue;
        }
        offset += 1;
      }
      await device.close();
      out.preset = Object.fromEntries(Object.entries(words).map(([addr, value]) => [`0x${Number(addr).toString(16).toUpperCase().padStart(4, '0')}`, value]));
      out.presetNonZero = Object.values(words).filter((value) => value !== 0).length;
    }

    out.diag = Array.from(document.querySelectorAll('.diag-log-row'))
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
      .filter((line) => line && !line.includes('0x2057'))
      .slice(-60);
    out.diagCount = text('.diag-count');
    return JSON.stringify(out);
  } catch (error) {
    return JSON.stringify({ ...out, fatal: String(error), stack: error && error.stack });
  }
})()
