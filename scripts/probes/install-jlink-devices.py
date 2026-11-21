# -*- coding: utf-8 -*-
"""把厂商 JinAudio 器件定义装进本地 J-Link（项目内《真机DFU首刷记录》§7 的官方路径）。

1. 复制 `third_party/设备相关/Release/SEGGER/JLink_696/Devices/JinAudio` → `<JLink>/Devices/JinAudio`
2. 把厂商 JLinkDevices.xml 里的 JinAudio `<ChipInfo>` 行并进 `<JLink>/JLinkDevices.xml`
3. 同样的器件定义再写一份到 %APPDATA%\\SEGGER\\JLinkDevices.xml（6.88+ 会优先读这里）
"""
import os
import shutil
import sys

REPO = r'D:\WorkShop\MicroPhone_WebHIDInterface'
VENDOR = os.path.join(REPO, 'third_party', '设备相关', 'Release', 'SEGGER', 'JLink_696')
JLINK = r'D:\Tools\JLink696'

vendor_xml = open(os.path.join(VENDOR, 'JLinkDevices.xml'), encoding='utf-8', errors='replace').read()
lines = [line for line in vendor_xml.splitlines() if 'JinAudio' in line and '<ChipInfo' in line]
if len(lines) < 3:
    print('vendor xml 里没找到 3 条 JinAudio 定义:', lines)
    sys.exit(2)
print('vendor JinAudio 定义:')
for line in lines:
    print('   ', line.strip())

# 1) 拷器件目录（FLM + JLinkScript）
src_dir = os.path.join(VENDOR, 'Devices', 'JinAudio')
dst_dir = os.path.join(JLINK, 'Devices', 'JinAudio')
if os.path.isdir(dst_dir):
    shutil.rmtree(dst_dir)
shutil.copytree(src_dir, dst_dir)
print('copied devices ->', dst_dir)
print('   files:', sorted(os.listdir(dst_dir)))


def merge(target_path):
    if not os.path.isfile(target_path):
        print('skip (missing):', target_path)
        return False
    text = open(target_path, encoding='utf-8', errors='replace').read()
    if 'JinAudio' in text:
        print('already merged:', target_path)
        return True
    block = '\n'.join(lines) + '\n'
    marker = '</DataBase>'
    if marker not in text:
        print('no </DataBase> in', target_path)
        return False
    merged = text.replace(marker, block + '  ' + marker, 1)
    open(target_path, 'w', encoding='utf-8', newline='').write(merged)
    print('merged ->', target_path)
    return True


merge(os.path.join(JLINK, 'JLinkDevices.xml'))
merge(os.path.join(os.environ.get('APPDATA', ''), 'SEGGER', 'JLinkDevices.xml'))
print('done')
