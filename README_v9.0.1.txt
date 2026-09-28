# 魔王S改枪码 v9.0.1

## 本版核心

腾讯文档同步解析器以已验证的 Java TencentSheetParser 为基准：

`opendoc -> block_datas[].related_sheet -> Base64 -> zlib -> Protobuf -> row/col/value 网格 -> 表头识别 -> 改枪码记录`

Protobuf 字段结构：

- 根：1 -> 5 -> 19
- 表体：5 = 值池，6 = 单元格
- 值池：1 = 字符串，3 = double 数字
- 单元格：1 = row，2 = col，3 = content
- content：1 = type（4 文本 / 2 数字），2 = value index

## 使用

1. 运行 `启动服务.bat`
2. 打开腾讯文档 Sheet 页面
3. 加载扩展目录 `extension`
4. 在腾讯文档页面点击浏览器工具栏中的“魔王S腾讯文档同步助手”
5. 选择 Sheet
6. 建议第一次先点“预览解析结果”
7. 确认记录、价格、日期、控枪编号无误后再“开始同步”

## 数据目录

- `data/tx/`：腾讯同步数据
- `data/my/`：手动新增数据
- `data/favorites.json`：收藏
- `data/invalid.json`：无效记录
- `data/config.json`：配置

## 重要

本版保留文本扫描作为 Protobuf 解析失败时的兜底，但正常情况下应以 `strategy=protobuf` 为准。
