魔王S腾讯同步助手 v8.3.19

本版更新：
1. 数据目录重构：data/tx/按“烽火地带/全面战场/爆破”分层保存腾讯同步数据。
2. 手动新增独立保存到 data/my/对应模式/自定义.csv。
3. 收藏与无效码改为服务端文件持久化：data/favorites.json、data/invalid.json，不再依赖浏览器缓存。
4. 删除 Excel/CSV 手动导入入口，只保留腾讯同步与手动新增。
5. 增加爆破模式数据架构；当前腾讯文档若没有爆破 Sheet 不会虚构数据。
6. 清理腾讯同步只删除 data/tx/，清理手动数据只删除 data/my/，互不影响。
7. 自动迁移旧版 data 根目录 CSV 到新目录；包含“魔王S外设-便携款...-S11烽火地带.csv”等旧同步文件。
8. 扩展版本号统一为 8.3.19。
10. 修复 server.ps1 中正则表达式被错误断行导致的 PowerShell ParserError，并统一保存为 UTF-8 BOM。
9. 保留 v8.2 的普通压枪 ID 多 related_sheet 解析逻辑。

本版本额外修复：网页 API 地址兼容同源 8080 与直接打开 HTML 两种方式；增加服务健康检查接口。


8.3.11 修复：修正腾讯文档 fallback 原始文本解析中“下一把枪的枪名标题”被拼入上一条备注的问题。


本版仅用于腾讯文档原始结构诊断：不会修改 data/tx。related_sheet 会按二进制/protobuf-like 数据输出 HEX、可打印字符串和字段结构；get/sheet 会输出 JSON 结构摘要。


8.3.16：不再把 v8.3.15 扫到的 0x22 记录误认为真实单元格；重点解压 initialAttributedText.workbook，检查真正工作簿载荷中的单元格文本、改枪码和表头信息。related_sheet 继续保留为格式/范围结构诊断。



v8.3.19：修复 fallback 文本解析中“独立枪名行 + 下一行改枪码”被并入上一条记录备注的问题；仅在备注片段与下一条改枪码枪名前缀对应时剔除标题，不影响复合备注。

v8.3.17：最终版候选。优先解析 get/sheet 的真实 numeric-key cell map；失败时自动尝试 legacy non-split 返回结构；不再把 0x22 样式/范围记录当作真实单元格。
