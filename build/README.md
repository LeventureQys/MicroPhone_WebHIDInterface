# build 资源目录

electron-builder 的 `buildResources` 目录。

品牌图标尚未提供，当前使用 Electron 默认图标。提供后按下列命名放入即可被自动采用：

- `icon.ico`（Windows，256×256 建议）
- `icon.icns`（macOS）
- `icon.png`（Linux，512×512）

放入 `icon.ico` 后，在 `electron-builder.yml` 的 `win` 段取消 `icon` 字段的注释。
