// 真机首次接触：确认厂商 HID 通道（Usage Page 0xFF01 / Usage 0x01）能被 WebHID 选中。
//   electron.exe . --screenshot=artifacts\real\enumerate.png --route=device --exec-file=scripts\probes\real-hid-enumerate.js --no-sandbox
// 只读枚举：不打开设备、不发任何报文。
(async () => {
  const hex = (value, digits) => `0x${Number(value).toString(16).toUpperCase().padStart(digits, '0')}`;

  const describe = (device) => ({
    vendorId: hex(device.vendorId, 4),
    productId: hex(device.productId, 4),
    productName: device.productName || null,
    serialNumber: device.serialNumber || null,
    opened: device.opened,
    collections: (device.collections ?? []).map((item) => ({
      usagePage: hex(item.usagePage, 4),
      usage: hex(item.usage, 4),
      inputReports: item.inputReports?.length ?? 0,
      outputReports: item.outputReports?.length ?? 0,
    })),
  });

  const hid = navigator.hid;
  if (!hid) return JSON.stringify({ error: 'navigator.hid 不可用' });

  const granted = await hid.getDevices();
  let chosen = [];
  let requested = false;
  let requestError = null;
  if (granted.length === 0) {
    requested = true;
    try {
      chosen = await hid.requestDevice({ filters: [{ usagePage: 0xff01, usage: 0x01 }] });
    } catch (error) {
      requestError = String(error && error.message ? error.message : error);
    }
  }

  return JSON.stringify({
    requested,
    requestError,
    granted: granted.map(describe),
    chosen: chosen.map(describe),
  });
})()
