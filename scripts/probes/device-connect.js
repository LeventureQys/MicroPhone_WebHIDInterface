// 设备页联调取证：先起桥接（python -m virtual_hid serve），再
//   electron.exe . --screenshot=artifacts/shot-device-live.png --route=device --exec-file=scripts/probes/device-connect.js
// 流程：连接桥 → 打开全部设备 → 让 echo 设备回环一条 output → 读回解码结果。
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const connect = document.querySelector('.device-actions .btn');
  if (!connect) return 'no connect button';
  connect.click();
  await wait(1500);

  const rows = Array.from(document.querySelectorAll('.device-row'));
  for (const row of rows) {
    row.querySelector('.btn')?.click();
    await wait(150);
  }
  await wait(400);

  let sent = null;
  const hid = navigator.hid;
  if (hid && typeof hid.getAllDevices === 'function') {
    const devices = await hid.getAllDevices();
    const echo = devices.find((device) => device.deviceId === 'echo');
    if (echo && echo.opened) {
      await echo.sendReport(0, Uint8Array.from([0xab, 0xcd]));
      sent = 'AB CD';
    }
  }
  await wait(800);

  return JSON.stringify({
    rows: rows.length,
    status: document.querySelector('.pfield-value')?.textContent ?? null,
    sent,
    hex: document.querySelector('.device-hex')?.textContent ?? null,
    fields: Array.from(document.querySelectorAll('.device-field')).map((node) => node.textContent),
  });
})()
