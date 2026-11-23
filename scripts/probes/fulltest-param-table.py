#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v1.1.3 全量测试：把 M001参数表V0.3.xlsx 导出成 JSON，供 P 系列逐项比对。

只读。用法：
  python scripts/probes/fulltest-param-table.py <xlsx> <out.json>

输出结构：
  {"file": ..., "sheets": {"设备信息": [[cell,...],...], ...}}
另附 infer 段：按 registers.ts 的地址推算规则（信息 0x0000、配置 0x1000、预设 0x2000 递增）
给每行补 addr，便于和 REGISTERS 对账。
"""
import json
import sys

from openpyxl import load_workbook


def main() -> int:
    src = sys.argv[1]
    dst = sys.argv[2]
    wb = load_workbook(src, data_only=True)
    out = {"file": src, "sheets": {}, "rows": []}
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            rows.append(["" if cell is None else str(cell) for cell in row])
        out["sheets"][ws.title] = rows

    # 地址按 registers.ts 注释的规则推算：三段各自从基址递增
    bases = {"设备信息": 0x0000, "设备配置": 0x1000, "设备当前预设": 0x2000}
    for title, rows in out["sheets"].items():
        base = None
        for name, value in bases.items():
            if title.startswith(name):
                base = value
        if base is None:
            continue
        idx = 0
        for row in rows:
            # 跳过表头/说明行：地址列（第 3 列，索引 2）必须是整数或可解析
            if len(row) < 8:
                continue
            cell = row[2].strip()
            try:
                addr = int(float(cell))
            except ValueError:
                # 表内地址列常是 16 进制显示（0x2000）或公式结果
                try:
                    addr = int(cell, 16) if cell.lower().startswith("0x") else None
                except ValueError:
                    addr = None
            if addr is None:
                continue
            out["rows"].append(
                {
                    "sheet": title,
                    "addr": addr,
                    "row": row,
                }
            )
            idx += 1

    with open(dst, "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=1)
    print(f"sheets={list(out['sheets'])} rows={len(out['rows'])} -> {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
