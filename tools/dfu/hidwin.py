"""Minimal Windows HID access via ctypes (no third-party packages).

Enumerates HID interfaces with SetupAPI/hid.dll, then exposes blocking-with-timeout
IN reports and OUT report writes for one interface path. Used by the M001 DFU probe
so the flashing path does not depend on Electron (whose multi-process IPC needs named
pipes that the confined shell cannot create).
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import time

hid = ctypes.WinDLL("hid.dll", use_last_error=True)
setupapi = ctypes.WinDLL("setupapi.dll", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32.dll", use_last_error=True)

DIGCF_PRESENT = 0x02
DIGCF_DEVICEINTERFACE = 0x10
ERROR_INSUFFICIENT_BUFFER = 122
ERROR_NO_MORE_ITEMS = 259
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x01
FILE_SHARE_WRITE = 0x02
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wt.DWORD),
        ("Data2", wt.WORD),
        ("Data3", wt.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class SP_DEVICE_INTERFACE_DATA(ctypes.Structure):
    _fields_ = [
        ("cbSize", wt.DWORD),
        ("InterfaceClassGuid", GUID),
        ("Flags", wt.DWORD),
        ("Reserved", ctypes.c_void_p),
    ]


class HIDD_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("Size", wt.ULONG),
        ("VendorID", wt.USHORT),
        ("ProductID", wt.USHORT),
        ("VersionNumber", wt.USHORT),
    ]


class HIDP_CAPS(ctypes.Structure):
    _fields_ = [
        ("Usage", wt.USHORT),
        ("UsagePage", wt.USHORT),
        ("InputReportByteLength", wt.USHORT),
        ("OutputReportByteLength", wt.USHORT),
        ("FeatureReportByteLength", wt.USHORT),
        ("Reserved", wt.USHORT * 17),
        ("NumberLinkCollectionNodes", wt.USHORT),
        ("NumberInputButtonCaps", wt.USHORT),
        ("NumberInputValueCaps", wt.USHORT),
        ("NumberInputDataIndices", wt.USHORT),
        ("NumberOutputButtonCaps", wt.USHORT),
        ("NumberOutputValueCaps", wt.USHORT),
        ("NumberOutputDataIndices", wt.USHORT),
        ("NumberFeatureButtonCaps", wt.USHORT),
        ("NumberFeatureValueCaps", wt.USHORT),
        ("NumberFeatureDataIndices", wt.USHORT),
    ]


setupapi.SetupDiGetClassDevsW.restype = ctypes.c_void_p
setupapi.SetupDiGetClassDevsW.argtypes = [ctypes.POINTER(GUID), wt.LPCWSTR, wt.HWND, wt.DWORD]
setupapi.SetupDiEnumDeviceInterfaces.restype = wt.BOOL
setupapi.SetupDiEnumDeviceInterfaces.argtypes = [
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.POINTER(GUID),
    wt.DWORD,
    ctypes.POINTER(SP_DEVICE_INTERFACE_DATA),
]
setupapi.SetupDiGetDeviceInterfaceDetailW.restype = wt.BOOL
setupapi.SetupDiGetDeviceInterfaceDetailW.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(SP_DEVICE_INTERFACE_DATA),
    ctypes.c_void_p,
    wt.DWORD,
    ctypes.POINTER(wt.DWORD),
    ctypes.c_void_p,
]
setupapi.SetupDiDestroyDeviceInfoList.argtypes = [ctypes.c_void_p]

hid.HidD_GetHidGuid.argtypes = [ctypes.POINTER(GUID)]
hid.HidD_GetAttributes.argtypes = [ctypes.c_void_p, ctypes.POINTER(HIDD_ATTRIBUTES)]
hid.HidD_GetProductString.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wt.ULONG]
hid.HidD_GetPreparsedData.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
hid.HidD_FreePreparsedData.argtypes = [ctypes.c_void_p]
hid.HidP_GetCaps.argtypes = [ctypes.c_void_p, ctypes.POINTER(HIDP_CAPS)]

kernel32.CreateFileW.restype = ctypes.c_void_p
kernel32.CreateFileW.argtypes = [
    wt.LPCWSTR,
    wt.DWORD,
    wt.DWORD,
    ctypes.c_void_p,
    wt.DWORD,
    wt.DWORD,
    ctypes.c_void_p,
]
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]


class OVERLAPPED(ctypes.Structure):
    _fields_ = [
        ("Internal", ctypes.c_void_p),
        ("InternalHigh", ctypes.c_void_p),
        ("Offset", wt.DWORD),
        ("OffsetHigh", wt.DWORD),
        ("hEvent", ctypes.c_void_p),
    ]


def _interface_paths():
    guid = GUID()
    hid.HidD_GetHidGuid(ctypes.byref(guid))
    handle = setupapi.SetupDiGetClassDevsW(
        ctypes.byref(guid), None, None, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
    )
    if handle in (None, INVALID_HANDLE_VALUE):
        raise OSError(f"SetupDiGetClassDevsW failed: {ctypes.get_last_error()}")
    paths = []
    try:
        index = 0
        while True:
            did = SP_DEVICE_INTERFACE_DATA()
            did.cbSize = ctypes.sizeof(did)
            if not setupapi.SetupDiEnumDeviceInterfaces(handle, None, ctypes.byref(guid), index, ctypes.byref(did)):
                error = ctypes.get_last_error()
                if error == ERROR_NO_MORE_ITEMS:
                    break
                raise OSError(f"SetupDiEnumDeviceInterfaces failed: {error}")
            index += 1
            required = wt.DWORD(0)
            setupapi.SetupDiGetDeviceInterfaceDetailW(handle, ctypes.byref(did), None, 0, ctypes.byref(required), None)
            if required.value == 0:
                continue
            buffer = ctypes.create_string_buffer(required.value)
            ctypes.memset(buffer, 0, required.value)
            # SP_DEVICE_INTERFACE_DETAIL_DATA_W.cbSize: 6 on x86, 8 on x64 (MSDN), not sizeof(SP_DEVICE_INTERFACE_DATA)
            cb_size = wt.DWORD(8 if ctypes.sizeof(ctypes.c_void_p) == 8 else 6)
            ctypes.memmove(buffer, ctypes.byref(cb_size), 4)
            if not setupapi.SetupDiGetDeviceInterfaceDetailW(
                handle, ctypes.byref(did), buffer, required.value, ctypes.byref(required), None
            ):
                continue
            raw = bytes(buffer)
            marker = "\\\\?\\".encode("utf-16-le")
            at = raw.find(marker)
            if at < 0:
                continue
            paths.append(raw[at:].decode("utf-16-le").split("\x00", 1)[0])
    finally:
        setupapi.SetupDiDestroyDeviceInfoList(handle)
    return paths


def enumerate_hid():
    """List every present HID interface with vid/pid/product/caps."""
    found = []
    for path in _interface_paths():
        handle = kernel32.CreateFileW(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, 0, None)
        if handle in (None, INVALID_HANDLE_VALUE):
            found.append({"path": path, "error": f"open-for-query failed {ctypes.get_last_error()}"})
            continue
        try:
            attributes = HIDD_ATTRIBUTES()
            attributes.Size = ctypes.sizeof(attributes)
            if not hid.HidD_GetAttributes(handle, ctypes.byref(attributes)):
                found.append({"path": path, "error": "HidD_GetAttributes failed"})
                continue
            text = ctypes.create_unicode_buffer(256)
            product = ""
            if hid.HidD_GetProductString(handle, text, ctypes.sizeof(text)):
                product = text.value
            caps = HIDP_CAPS()
            preparsed = ctypes.c_void_p()
            ok = hid.HidD_GetPreparsedData(handle, ctypes.byref(preparsed))
            if ok:
                try:
                    hid.HidP_GetCaps(preparsed, ctypes.byref(caps))
                finally:
                    hid.HidD_FreePreparsedData(preparsed)
            found.append(
                {
                    "path": path,
                    "vid": f"0x{attributes.VendorID:04X}",
                    "pid": f"0x{attributes.ProductID:04X}",
                    "version": f"0x{attributes.VersionNumber:04X}",
                    "product": product,
                    "usagePage": f"0x{caps.UsagePage:04X}",
                    "usage": f"0x{caps.Usage:04X}",
                    "inLen": caps.InputReportByteLength,
                    "outLen": caps.OutputReportByteLength,
                    "featureLen": caps.FeatureReportByteLength,
                }
            )
        finally:
            kernel32.CloseHandle(handle)
    return found


class HidDevice:
    """Overlapped handle for one HID interface; reportId is included in every buffer."""

    def __init__(self, path: str):
        self.path = path
        self.handle = kernel32.CreateFileW(
            path,
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            None,
        )
        if self.handle in (None, INVALID_HANDLE_VALUE):
            raise OSError(f"CreateFile failed for {path}: {ctypes.get_last_error()}")
        self._write_event = kernel32.CreateEventW(None, True, False, None)
        self._read_event = kernel32.CreateEventW(None, True, False, None)
        self._read_buffer = ctypes.create_string_buffer(1024)

    def close(self):
        for event in (self._write_event, self._read_event):
            if event:
                kernel32.CloseHandle(event)
        if self.handle not in (None, INVALID_HANDLE_VALUE):
            kernel32.CloseHandle(self.handle)
            self.handle = None

    def write(self, data: bytes, timeout_ms: int = 2000) -> float:
        started = time.perf_counter()
        overlapped = OVERLAPPED()
        overlapped.hEvent = self._write_event
        kernel32.ResetEvent(self._write_event)
        written = wt.DWORD(0)
        ok = kernel32.WriteFile(self.handle, data, len(data), ctypes.byref(written), ctypes.byref(overlapped))
        if not ok:
            error = ctypes.get_last_error()
            if error != 997:  # ERROR_IO_PENDING
                raise OSError(f"WriteFile failed: {error}")
            wait = kernel32.WaitForSingleObject(self._write_event, timeout_ms)
            if wait != 0:
                kernel32.CancelIoEx(self.handle, ctypes.byref(overlapped))
                raise TimeoutError(f"WriteFile timeout {timeout_ms} ms")
            if not kernel32.GetOverlappedResult(self.handle, ctypes.byref(overlapped), ctypes.byref(written), False):
                raise OSError(f"GetOverlappedResult(write) failed: {ctypes.get_last_error()}")
        return (time.perf_counter() - started) * 1000.0

    def read(self, timeout_ms: int = 200):
        """Return (report bytes incl. report id) or None on timeout."""
        overlapped = OVERLAPPED()
        overlapped.hEvent = self._read_event
        kernel32.ResetEvent(self._read_event)
        read = wt.DWORD(0)
        ok = kernel32.ReadFile(
            self.handle, self._read_buffer, len(self._read_buffer), ctypes.byref(read), ctypes.byref(overlapped)
        )
        if not ok:
            error = ctypes.get_last_error()
            if error != 997:
                raise OSError(f"ReadFile failed: {error}")
            wait = kernel32.WaitForSingleObject(self._read_event, int(timeout_ms))
            if wait != 0:
                kernel32.CancelIoEx(self.handle, ctypes.byref(overlapped))
                # reap the cancelled transfer so the buffer is not written after return
                kernel32.GetOverlappedResult(self.handle, ctypes.byref(overlapped), ctypes.byref(read), True)
                return None
            if not kernel32.GetOverlappedResult(self.handle, ctypes.byref(overlapped), ctypes.byref(read), False):
                return None
        return bytes(self._read_buffer.raw[: read.value])


kernel32.CreateEventW.restype = ctypes.c_void_p
kernel32.CreateEventW.argtypes = [ctypes.c_void_p, wt.BOOL, wt.BOOL, wt.LPCWSTR]
kernel32.ResetEvent.argtypes = [ctypes.c_void_p]
kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, wt.DWORD]
kernel32.GetOverlappedResult.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(OVERLAPPED),
    ctypes.POINTER(wt.DWORD),
    wt.BOOL,
]
kernel32.CancelIoEx.argtypes = [ctypes.c_void_p, ctypes.POINTER(OVERLAPPED)]
kernel32.WriteFile.argtypes = [
    ctypes.c_void_p,
    ctypes.c_char_p,
    wt.DWORD,
    ctypes.POINTER(wt.DWORD),
    ctypes.POINTER(OVERLAPPED),
]
kernel32.ReadFile.argtypes = [
    ctypes.c_void_p,
    ctypes.c_void_p,
    wt.DWORD,
    ctypes.POINTER(wt.DWORD),
    ctypes.POINTER(OVERLAPPED),
]
