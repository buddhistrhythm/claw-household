# Baby Tracker (.btcp) 格式说明

**来源**: [Baby Tracker - Newborn Log](https://apps.apple.com/us/app/baby-tracker-newborn-log/id779656557) by Nighp Software

## 文件结构

`.btcp` 文件是一个 ZIP 压缩包，解压后包含：

```
snapshot.btcp (ZIP)
├── EasyLog.db           ← SQLite 数据库（核心数据）
└── <UUID>.jpg           ← 宝宝头像（可选）
```

## EasyLog.db 表结构

### Baby（宝宝信息）
| 字段 | 类型 | 说明 |
|------|------|------|
| ID | TEXT | UUID |
| Name | TEXT | 宝宝名字 |
| DOB | REAL | 出生日期（Unix 时间戳，秒） |
| Gender | INTEGER | 0=女，1=男 |
| DueDay | REAL | 预产期（Unix 时间戳） |
| Picture | TEXT | 头像文件名（不含路径） |

### Diaper（换尿布）
| 字段 | 类型 | 说明 |
|------|------|------|
| Time | REAL | 事件时间（Unix 时间戳，秒） |
| Status | INTEGER | 0=湿/尿，1=脏/便，2=尿+便 |
| Note | TEXT | 备注 |
| BabyID | TEXT | 关联 Baby.ID |

### Formula（冲奶/奶瓶喂养）
| 字段 | 类型 | 说明 |
|------|------|------|
| Time | REAL | 事件时间（Unix 时间戳） |
| Amount | REAL | 喂奶量 |
| IsEnglishScale | INTEGER | 0=毫升(ml)，1=液量盎司(oz, 1oz≈29.574ml) |
| DescID | TEXT | 关联 FeedDesc.ID（可选，喂后反应） |
| Note | TEXT | 备注 |

### Nursing（母乳喂养）
| 字段 | 类型 | 说明 |
|------|------|------|
| Time | REAL | 开始时间 |
| LeftDuration | INTEGER | 左侧时长（秒） |
| RightDuration | INTEGER | 右侧时长（秒） |
| BothDuration | INTEGER | 双侧时长（秒） |
| FinishSide | INTEGER | 结束侧 |

### Sleep（睡眠）
| 字段 | 类型 | 说明 |
|------|------|------|
| Time | REAL | 入睡时间（Unix 时间戳） |
| Duration | INTEGER | 睡眠时长（**分钟**） |
| LocationID | TEXT | 关联 SleepLocationSelection.ID（可选） |

### Growth（生长数据）
| 字段 | 类型 | 说明 |
|------|------|------|
| Time | REAL | 测量时间 |
| Weight | REAL | 体重；IsEnglishWeightScale=0→kg，1→lbs |
| Length | REAL | 身长；IsEnglishLengthScale=0→cm，1→inch |
| Head | REAL | 头围；单位同 Length |
| IsEnglishWeightScale | INTEGER | 0=公制，1=英制 |
| IsEnglishLengthScale | INTEGER | 0=公制，1=英制 |

### Milestone（成长里程碑）
| 字段 | 类型 | 说明 |
|------|------|------|
| Time | REAL | 发生时间 |
| MilestoneSelectionID | TEXT | 关联 MilestoneSelection.ID |
| Note | TEXT | 自定义备注 |

**MilestoneSelection.Name** 包含内置里程碑名称（英文），如 "First smile"、"Raise head"。

### OtherFeed（辅食/其他喂食）
| 字段 | 类型 | 说明 |
|------|------|------|
| Time | REAL | 事件时间 |
| Amount | REAL | 量（ml 或自定义） |
| DescID | TEXT | 关联 OtherFeedSelection.ID（食物名称） |

## 时间戳说明

所有 `Time` / `Timestamp` 字段均为 **Unix 时间戳（秒，REAL 类型）**。

转换方式（SQLite）：
```sql
datetime(Time, 'unixepoch')          -- UTC 时间
datetime(Time, 'unixepoch', '+8 hours')  -- 北京时间
```

## 导入映射

| btcp 表 | 映射到 baby_log.json type |
|---------|--------------------------|
| Diaper | `diaper` |
| Formula | `feeding_bottle` |
| Nursing | `feeding_nursing` |
| Sleep | `sleep` |
| Growth | `growth` |
| Milestone | `milestone` |
| OtherFeed | `feeding_solid` |

## 已知数据规模参考

导出文件约 1.2MB，包含：
- Diaper: 721 条
- Formula: 900 条
- Sleep: 4 条
- Growth: 6 条
