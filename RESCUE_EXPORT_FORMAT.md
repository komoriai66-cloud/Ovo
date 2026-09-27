# 救援导出文件格式

旧链接的 `rescue-export.html` 只读取当前网页或 PWA 所在存储区的数据，不会修改旧数据库。此文档说明文件内容，供独立的导入程序使用；旧链接本身不执行导入。

## 文件

- `UWU-救援-<backupId>-001.zip`、`002.zip` 等：每个文件都是独立的标准 ZIP，内有一个 `payload.ndjson.fragment` 条目。ZIP 可采用 STORE 或 DEFLATE。
- `UWU-救援-<backupId>-清单.json`：列出全部分卷、大小、原始片段和 ZIP 的 SHA-256、数据表计数及排除的本地设置键。清单仅在全部分卷生成后出现。

按照清单 `parts` 数组顺序，分别解压每卷的 `payload.ndjson.fragment`，**先连接字节，再按 UTF-8 解码和按换行解析 JSON**。一条 JSON 记录可能跨越分卷边界；单独解析某卷的片段会失败。不要把全部片段一次放进内存，导入方应连续读取和解析。

## JSON Lines 记录

- `{"kind":"row","store":"characters","key":"...","historyLength":123,"value":{...}}`：角色或群组的主体记录。`history` 从 `value` 中移出，`historyLength` 在记录外层。
- `{"kind":"history","store":"characters","key":"...","index":0,"value":{...}}`：按 `index` 还原角色或群组的 `history` 数组。
- 其他 IndexedDB 数据表使用 `row`，包括旧结构中的 `storage` 表（若存在）。实际导出所有存在的数据表。
- `{"kind":"localStorage","key":"...","value":"..."}`：当前源环境的本地设置。默认排除登录凭据及部分云端配置；清单记录排除的键。导入方应按白名单选择需要恢复的设置，不应直接恢复旧链接的登录状态。

记录中的大型字符串以小段序列化，但生成的 JSON 值与原值相同。原生二进制和其他结构化克隆值使用带类型标签的包装对象：`__uwuRescueBinary__`、`__uwuRescueDate__`、`__uwuRescueBigInt__`、`__uwuRescueMap__`、`__uwuRescueSet__`、`__uwuRescueRegExp__`。二进制包装对象的 `base64` 是原字节；Blob/File 还带 MIME 类型等字段。导入方必须还原这些类型；普通业务对象应保持所有原字段。

## 完整性与边界

导入前先核对清单中所有分卷是否存在，以及各卷 ZIP 字节数和 SHA-256。缺卷或校验失败时不得报告完整导入。清单中的 `backupId` 防止混用不同备份。用户若在导出中途修改旧数据，应重新生成整套备份。

旧数据的某个 IndexedDB 记录本身若大到浏览器无法读取，独立页面也无法绕过设备内存限制。网页也无法直接确认手机已经完成下载，因此导出页提供把保存的文件选回并逐一核验的功能。
