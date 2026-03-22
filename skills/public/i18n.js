function getLang() {
  const overrides = localStorage.getItem('lang');
  if (overrides) return overrides;
  return (navigator.language || 'zh').toLowerCase();
}

window.I18N_EN = {
  // Common
  "刷新": "Refresh",
  "取消": "Cancel",
  "保存更改": "Save Changes",
  "列表": "List",
  "未命名": "Unnamed",
  "数量": "Quantity",
  "单位": "Unit",
  "名称": "Name",
  "日期": "Date",
  "更多": "More",
  "商品": "Product",
  "备注（Notes）": "Notes",
  "购买平台": "Platform",
  "有效期": "Expiry Date",
  "优先级": "Priority",

  // Tabs
  "储物": "Inventory",
  "补货": "Restock",
  "做菜": "Cooking",
  "日历": "Calendar",
  "设置": "Settings",
  "宝宝": "Baby",
  "转运": "Transit",
  "养车": "Car Care",

  // Header & Status
  "解析中…": "Parsing...",
  "提交中...": "Submitting...",
  "入库中...": "Adding...",
  "保存中…": "Saving...",
  "加载中...": "Loading...",
  "正在导入...": "Importing...",
  "加载餐食数据失败": "Failed to load meal data",
  "✓ 已保存": "✓ Saved",
  "网络错误": "Network Error",
  "未知错误": "Unknown Error",
  
  // Inventory UI
  "储物为空": "Inventory is empty",
  "在上方扫码或拍照入库": "Scan or take a photo above to add",
  "暂无符合条件的库存，请先在库存 Tab 入库（排除尿裤/药品等非食材品类）": "No matching inventory, please add items in Inventory Tab first (excluding diapers/medicines)",
  "自动识别（推荐）": "Auto Object Detection (Recommended)",
  "拍照入库": "Photo Entry",
  "拖拽调整优先级。最多显示 4 个，其余折叠进「更多」。": "Drag to reorder. Shows up to 4 tabs, others collapse into 'More'.",
  "✓ 确认入库": "✓ Confirm",
  "预选：可修改下方表单后点「确认入库」": "Preview: Edit below, then click Confirm",
  "自然语言描述，回车/失焦自动解析": "Natural language description, press Enter to parse",
  "请先输入商品描述": "Please enter product description first",
  "点击或拖拽 .btcp 到此处（与库存预测联动）": "Click or drag .btcp here",

  // App UI Placeholders & Tags
  "如：爱他美白金奶粉 900g 一箱6罐": "e.g., Aptamil Gold 900g 1 case 6 cans",
  "如花王、帮宝适": "e.g., Pampers, Huggies",
  "如 L、XL": "e.g., L, XL",
  "如 90": "e.g., 90",
  "如 24": "e.g., 24",
  "个": "pcs",
  "包": "pack",
  "片": "piece",

  // Diaper & Baby
  "宝宝用品": "Baby Items",
  "🍼 宝宝用品": "🍼 Baby Items",
  "记录换尿布": "Diaper Log",
  "🩲 记录换尿布": "🩲 Diaper Log",
  "奶量 ml": "Volume (ml)",
  "今日喂奶": "Today's Feeding",
  "奶瓶喂奶": "Bottle Feeding",
  "大小便": "Diaper Change",
  "睡眠": "Sleep",
  "1 段": "Stage 1",
  "2 段": "Stage 2",
  "体重下限 (kg)": "Min Weight (kg)",
  "体重上限 (kg)": "Max Weight (kg)",
  "体重上限 kg": "Max Weight (kg)",
  "请填写有效的体重上下限 (kg)": "Please enter valid min/max weight (kg)",
  "请填写品牌": "Please enter brand",
  "请填写段位代码": "Please enter stage code",
  "暂无生长体重记录，段位预测未启用": "No growth data, diaper segment prediction disabled",
  "✓ 本段位消耗计入": "✓ Consumed in this segment",
  "⚠️ 当前体重不在本 SKU 区间": "⚠️ Current weight not in this SKU range",

  // Categories & Location
  "品牌（默认同上方品牌）": "Brand (defaults to above)",
  "储物种类": "Inventory Category",
  "购买渠道（可多选）": "Purchase Channels",
  "从列表选或输入新店名，点添加": "Select or type new store, click add",
  "未设置渠道": "No Channel Set",
  "按购买渠道": "By Purchase Channel",

  // Filters & State
  "全部（除即将过期）": "All (Excl. Expiring)",
  "全部": "All",
  "待处理（做菜待买）": "Pending (To Buy)",
  "即将耗尽": "Empty soon",
  "即将过期": "Expiring",
  "⚠️ 即将过期": "⚠️ Expiring",
  "🛒 需补货": "🛒 Need Restock",
  "📌 常买": "📌 Frequent",
  "已标为常买食材": "Marked as frequent",
  "已取消常买": "Unmarked frequent",
  "已清除密文": "Secret cleared",
  "尚未保存卡号/券码密文": "No secret saved yet",
  "已保存 · 输入新值可覆盖": "Saved · Enter new to overwrite",
  "仅在此输入敏感信息；保存后磁盘仅存密文": "Sensitive info; saved encrypted on disk",
  "显示已存内容": "Reveal Saved Content",
  "🔐 卡号 / 兑换码 / PIN（加密存储）": "🔐 Card / Code / PIN (Encrypted)",

  // Restock & Cooking
  "大模型生成推荐菜": "AI Recipe Recommendations",
  "⭐ 收藏的菜": "⭐ Favorite Recipes",
  "记这一餐": "Log Meal",
  "已记录这一餐": "Meal logged",
  "本月餐次": "Meals this month",
  "早餐": "Breakfast",
  "午餐": "Lunch",
  "晚餐": "Dinner",
  "加餐": "Snack",
  "吃了哪些菜（从菜谱选，可多选）": "What dishes did you eat? (Select from recipes)",
  "新建菜谱（菜）": "New Recipe",
  "清空表单": "Clear Form",
  "暂无国内运单": "No Domestic Parcels",
  "国内运单（商品）": "Domestic Parcels",
  "美国运单": "US Tracking",
  "快递单号": "Tracking #",
  "暂无已保存的密文": "No saved secrets",
  "家庭与多宝宝": "Family & Babies",
  "保存宝宝列表": "Save Babies",
  "保存车辆列表": "Save Vehicles",
  "养车（车辆与时间）": "Car Care",
  "当前里程（km，可留空）": "Current Mileage (km, optional)",
  "+ 添加车辆": "Add Vehicle",
  
  // Selection
  "— 选择模板 —": "— Select Template —",
  "— 未关联 —": "— Unlinked —",
  "— 未设置 —": "— Not Set —",
  "— 未选 —": "— None —",
  "（不套用）": "— Skip Template —",
  "默认（系统文案）": "Default",
  "通用模板": "Generic Template",
  
  // Transit
  "已取到": "Picked Up",
  "运费金额（元）": "Shipping Fee",

  // Miscellaneous Strings
  "名称不能为空": "Name cannot be empty",
  "超时（毫秒，5s–600s）": "Timeout (ms, 5s-600s)",
  "鉴权方式": "Auth Style",
  "调用方式": "Invocation",
  "参数（JSON 数组）": "Args (JSON Array)",
  "需为合法 JSON；用": "Must be valid JSON; use",
  "中执行命令，不经过 shell。参数为 JSON 数组，支持占位符": "execute command without shell. Array with placeholders",
  "插入模型名与已转义的用户提示词。": "inserts model name and escaped prompt.",
  "HTTP（OpenAI 兼容 API）": "HTTP (OpenAI Compatible)",
  "x-api-key（如 Anthropic 等）": "x-api-key",
  "填写后保存；已配置时显示占位": "Save to config; shows placeholder if set",
  "自动识别完成（置信度：": "Auto-detection done (Confidence: ",
  "高置信度": "High Confidence",
  "中置信度": "Medium Confidence",
  "低置信度": "Low Confidence",
  "识别失败：": "Recognition failed: ",
  "入库失败": "Failed to add",
  "保存失败": "Failed to save",
  "删除失败": "Failed to delete",
  "记录失败": "Failed to log",
  "操作失败": "Operation failed",
  "没有可导出的渠道（请先勾选上方渠道）": "No channels to export (select channels first)",
  "暂无。点击下方添加车辆；数据保存在 config/cars.json。": "None. Add below; saved in config/cars.json.",
  "尚无记录，成功入库后会出现在这里": "No records yet, added items will appear here",
  "最近录入（点选填入表单，不会自动提交）": "Recent Entries (Click to auto-fill)",
  "最近记录的餐": "Recent Meals",
  "拖拽调整优先级": "Drag to prioritize",

  "大模型推荐需在": "AI recommendation requires",
  "副标题在页头「家用AI」下方。可选默认、自定义模板（占位符": "Subtitle below 'Household AI'. Custom templates support",
  "。取 stdout 第一行非空作为副标题。": ". Uses first non-empty line of stdout as subtitle.",

  "暂无，新建菜谱时勾选「加入收藏」": "Empty, check 'Add to favorites' when creating a recipe",
  "找不到菜谱": "Recipe not found",
  "已保存菜谱": "Recipe saved",

  // Actions
  "✓ 已在库存中标记需补货": "✓ Marked for restock",
  "✓ 已加入做菜待买（补货 Tab）": "✓ Added to pending (Restock tab)",
  "✓ 已保存该品牌段位": "✓ Segment saved",
  "删除": "Delete",
  "编辑": "Edit",
  "确认": "Confirm",
  "退出": "Exit",

  // Form Fields
  "单价（元）": "Unit Price",
  "存放位置": "Location",
  "保质期至（可选）": "Expiry (Optional)",
  "本次入库数量 *": "Restock Qty *",
  "确认补货": "Confirm Restock",
  "物品属性": "Item Properties",
  "留言 / 记录（Comments）": "Comments",
  "图标": "Icon",
  "品类": "Category",
  "需补货": "Need Restock",

  // Missing Settings Hints
  "宝宝（有宝宝时才显示底部「宝宝」Tab）": "Babies (Shows Baby Tab when added)",
  "在此添加多个宝宝后，底部会出现宝宝 Tab，并显示名字。若列表为空且未从宝宝档案同步到名字，则不显示该 Tab。": "Add babies here. If empty and unsynced, the Baby Tab is hidden.",
  "车辆与保养项目保存在 config/cars.json（可进 git）。至少一辆车时显示「养车」Tab；时间表在养车页编辑「本次已做」。": "Vehicles & schedules are in config/cars.json. At least one vehicle activates 'Car Care' Tab.",
  "暂无。点击下方添加；保存为空列表可隐藏底部宝宝 Tab（不再从档案自动合并）。": "None. Add below; saving an empty list hides the Baby Tab.",

  // Timeline
  "入库": "Restock",
  "三餐": "Meal",
  "辅食": "Solid Food",

  // Categories & Dynamically Loaded Location Names
  "食品杂项": "Misc Food",
  "宝宝用品杂项": "Misc Baby Items",
  "母婴服务": "Baby Services",
  "生活杂项": "Misc Home",
  "数码杂项": "Misc Digital",
  "医疗健康杂项": "Misc Health",
  "冰箱冷藏": "Fridge (Chilled)",
  "储物柜": "Storage Cabinet",
  "衣柜": "Wardrobe",
  "衣帽间": "Closet",
  "杂物箱": "Misc Box",
  "电子保管": "Digital Vault",
  "宝宝用品柜": "Baby Wardrobe",
  "冰箱冷冻": "Freezer",

  // Toasts
  "已删除": "Deleted",
  "删除失败": "Delete Failed",

  // Cooking & Settings Additional Instructions
  "底部 Tab 顺序": "Bottom Tab Order",
  "记录每餐吃了什么；菜谱用料与库存同名即可自动对货。补货 Tab 默认只汇总「常买食材」和宝宝用品；其它请右滑标记需补货或从下方推荐加入。": "Log meals here; exact item match syncs with inventory. 'Restock' tab only summarizes recurring and baby items by default.",
  "🍳 智能推荐": "🍳 Smart Recommendations",
  "大模型推荐需在": "AI recommendations require",
  "的": " ",
  "中配置 API（或本地 CLI）后使用。": "API config (or local CLI) to use.",
  "可选：口味、时间、想吃的类型…": "Optional: Taste, time, desired type...",
  "按住 Cmd/Ctrl 多选；无选项时先在下方「新建菜谱」添加。": "Hold Cmd/Ctrl to multi-select; add in 'New Recipe' below if none available.",
  "备注": "Remarks",
  "口味、和谁一起吃…": "Taste, who you ate with...",
  "保存这一餐": "Save Meal",
  "菜名": "Dish Name",
  "如：番茄炒蛋": "e.g., Scrambled Eggs with Tomato",
  "鸡蛋 2个\n番茄 2个": "Eggs 2 pcs\nTomato 2 pcs",
  "用料（食材，每行一项，可选）": "Ingredients (one per line, optional)",
  "做法 / 步骤": "Steps / Method",
  "好吃就记下来…": "Note down if it tastes good...",
  "加入收藏": "Add to Favorites",
  "保存菜谱": "Save Recipe",
  "食材库（与储物同一套）": "Ingredient Library (Shared with Inventory)",
  "来自储物中「可做菜」品类；新食材请在": "From 'Cooking' category in inventory; add new ones in ",
  "Tab 入库。勾选「常买」后，消耗预测才会自动进入补货 Tab。": " Tab. Select 'Frequent' for auto-restock predictions.",
  "最近记录的餐": "Recently Logged Meals",

  "宝宝记录": "Baby Logs",
  "👶 宝宝记录": "👶 Baby Logs",
  "本月入库": "Restocks This Month",
  "食材 · 菜 · 每一餐": "Ingredients · Dishes · Meals",
  "餐次": "Meal Slot",

  // Automatically mapped missing nodes
  "AI \u6b63\u5728\u8bc6\u522b\u5546\u54c1\u4fe1\u606f...": "AI is identifying item info...",
  "API Key\uff08\u4ec5\u4fdd\u5b58\u5230\u670d\u52a1\u7aef\uff1b\u7559\u7a7a\u8868\u793a\u4e0d\u6539\uff09": "API Key (Saved on server; leave blank to keep)",
  "Household Agent \u00b7 \u5bb6\u7528AI": "Household Agent \u00b7 AI",
  "POST \u5230\u4e0b\u5217 URL\uff0c\u9ed8\u8ba4\u8bf7\u6c42\u4f53\u4e3a": "POST to following URL, default body is",
  "xxxx-xx-xx \u65f6\u95f4\u8868": "xxxx-xx-xx Timeline",
  "\u26a0\ufe0f {urgent} \u4ef6\u5373\u5c06\u8fc7\u671f": "\u26a0\ufe0f {urgent} item(s) expiring soon",
  "\u270f\ufe0f \u624b\u52a8\u5f55\u5165": "\u270f\ufe0f Manual Entry",
  "\u2713 \u786e\u8ba4\u8bb0\u5f55": "\u2713 Confirm Log",
  "\u4e00\u74f6\u591a\u5c11 g\uff08\u6309\u89c4\u683c\u81ea\u52a8\u586b\u5145\uff0c\u53ef\u4fee\u6539\uff09": "Weight per bottle in g (auto-filled by spec)",
  "\u4e0a\u6b21\u4fdd\u517b": "Last Maintenance",
  "\u4e3a\u5f53\u524d\u54c1\u724c\u4fdd\u5b58\u4e00\u6bb5\u4f53\u91cd\u533a\u95f4\uff0c\u4fdd\u5b58\u540e\u4e0a\u65b9\u300c\u5c3f\u88e4\u6bb5\u4f4d\u300d\u4e0b\u62c9\u4f1a\u4f18\u5148\u663e\u793a\u8be5\u54c1\u724c\u7684\u6bb5\u4f4d\u3002": "Save a weight range for current brand to prioritize it in the 'Diaper Size' dropdown.",
  "\u4f4e": "Low",
  "\u4f53\u91cd\u4e0b\u9650 kg": "Min Weight kg",
  "\u4fdd\u5b58 Tab \u8bbe\u7f6e": "Save Tab Settings",
  "\u4fdd\u5b58\u5c0f\u6807\u9898\u4e0e LLM": "Save Subtitle & LLM",
  "\u4fdd\u5b58\u8be5\u54c1\u724c\u6bb5\u4f4d": "Save Brand Size",
  "\u5171 {count} \u6761 \u00b7 \u2026": "Total {count} logs \u00b7 ...",
  "\u5173\u95ed": "Close",
  "\u5199\u4e00\u6761\u65b0\u7559\u8a00\u2026": "Write a new comment...",
  "\u5305\u88c5\u89c4\u683c\uff08\u53ef\u9009\uff0c\u5982\uff1a\u4e00\u7bb124\u74f6\u3001\u6bcf\u530548\u7247\uff09": "Packaging (Optional, e.g., 24 bottles)",
  "\u53d6\u6d88\u626b\u63cf": "Cancel Scan",
  "\u53d6\u6d88\u9884\u9009": "Cancel Preview",
  "\u53ef\u9009": "Optional",
  "\u547d\u4ee4": "Command",
  "\u54c1\u724c": "Brand",
  "\u5546\u54c1\u540d\u79f0": "Item Name",
  "\u5546\u54c1\u540d\u79f0 *": "Item Name *",
  "\u56fe\u6807\uff08emoji\uff09": "Icon (emoji)",
  "\u5927\u6a21\u578b\u751f\u6210\uff08completion\uff09": "LLM Generation (completion)",
  "\u5927\u74f6 32oz\uff08\u6309\u5976\u91cf\u6bd4\u4f8b\u6263\u74f6\uff0c\u53ef\u6709\u96f6\u6709\u6574\uff09": "Large 32oz (deducts bottle based on volume)",
  "\u5982 6901234567890\uff0c\u65e0\u5219\u7559\u7a7a": "e.g. 6901234567890, leave blank if none",
  "\u5982 L \u5927\u53f7": "e.g. Size L",
  "\u5982 \ud83e\udd6c \u7559\u7a7a\u5219\u7528\u54c1\u7c7b\u9ed8\u8ba4": "e.g. \ud83e\udd6c leave blank for category default",
  "\u5b58\u653e\u8bf4\u660e\u3001\u7528\u6cd5\u7b49": "Storage instructions, usage, etc.",
  "\u5bfc\u5165": "Import",
  "\u5bfc\u5165\u670d\u52a1\u5386\u53f2\u8bb0\u5f55": "Import Service History",
  "\u5c06\u6761\u7801\u5bf9\u51c6\u6846\u5185\uff0c\u81ea\u52a8\u8bc6\u522b": "Align barcode in frame for auto-recognition",
  "\u5c0f\u74f6 2oz\uff08\u6bcf\u6b21\u5582\u5976\u6309\u74f6\u6570\u5411\u4e0a\u53d6\u6574\uff09": "Small 2oz (rounds up by bottle for each feed)",
  "\u5c3f\u88e4\u6bb5\u4f4d": "Diaper Size",
  "\u5de5\u4f5c\u76ee\u5f55\uff08\u53ef\u9009\uff09": "Working Dir (Optional)",
  "\u5e38\u4e70\u98df\u6750": "Frequent Food",
  "\u5e93\u5b58\u6570\u91cf\u4ecd\u4ee5\u300c\u7247\u300d\u8ba1\uff1b\u8865\u8d27\u9884\u6d4b\u4f1a\u6309\u751f\u957f\u4f53\u91cd\u628a\u6362\u5c3f\u5e03\u8ba1\u5165\u5f53\u524d\u6bb5\u4f4d SKU\u3002": "Inventory counted in pieces; auto-reorders based on growth weight mapping.",
  "\u5e93\u5b58\u6570\u91cf\u6309\u300c\u74f6\u300d\u8ba1\uff1b\u5b9d\u5b9d\u5582\u5976\u8bb0\u5f55\u8bf7\u9009\u62e9\u300c\u6c34\u5976\u300d\u624d\u4f1a\u8ba1\u5165\u672c SKU\u3002\u51b2\u8c03\u7528\u5976\u7c89\u4ecd\u9009\u300c\u5976\u7c89\u51b2\u8c03\u300d\u3002": "Inventory in 'bottles'; baby log must use 'liquid milk' to sync with this SKU.",
  "\u5efa\u8bae\u95f4\u9694": "Suggested Interval",
  "\u5fc5\u586b\uff1a\u5546\u54c1\u540d\u79f0\uff1b\u5176\u4f59\u53ef\u7a7a\u3002\u5c3f\u88e4\u54c1\u7c7b\u9700\u586b\u4f53\u91cd\u533a\u95f4\u3002": "Required: Product Name; Diaper requires weight range.",
  "\u5feb\u6377\u9884\u8bbe\uff08\u4ec5\u4f9b\u53c2\u8003\uff0c\u8bf7\u6309\u672c\u673a CLI \u5b9e\u9645\u53c2\u6570\u8c03\u6574\uff09": "Quick Presets (Please adjust based on your local CLI)",
  "\u603b\u91cd": "Total Weight",
  "\u603b\u91cd\uff08kg\uff09": "Total Weight (kg)",
  "\u624b\u52a8\u5f55\u5165": "Manual Entry",
  "\u626b\u7801\u5165\u5e93": "Scan to Inventory",
  "\u6279\u6b21\u540d\u79f0": "Batch Name",
  "\u6309\u54c1\u724c\u5bfc\u5165\u6bb5\u4f4d\uff08\u65e0\u5408\u9002\u6a21\u677f\u65f6\u7528\uff09": "Import Sizes by Brand (use if no template fits)",
  "\u6309\u9879\u76ee\u8bb0\u5f55": "Log by Item",
  "\u65e0\uff08\u672c\u5730 Ollama \u7b49\uff09": "None (e.g., Local Ollama)",
  "\u65e5\u5386\u805a\u5408\uff1a\u5f53\u65e5\u5165\u5e93\uff08purchase_date\uff09\u3001\u5b9d\u5b9d\u65e5\u5fd7\u3001\u9910\u98df\u8bb0\u5f55\u3002\u8865\u8d27\u6765\u6e90\u53d6\u81ea\u7269\u54c1\u7684\u8d2d\u4e70\u6e20\u9053\u3002": "Calendar aggregates: Restocks, Baby Logs, Meals. Restock channel is from item purchase channels.",
  "\u65f6\u95f4": "Time",
  "\u663e\u793a\u540d\u79f0": "Display Name",
  "\u672c\u5730 CLI\uff08claude / gemini / codex \u7b49\uff09": "Local CLI (claude / gemini, etc.)",
  "\u6761\u7801\u626b\u63cf": "Barcode Scan",
  "\u6761\u7801\uff08\u53ef\u9009\uff0c\u7eaf\u6570\u5b57\uff09": "Barcode (Optional, numeric only)",
  "\u6765\u6e90\u683c\u5f0f": "Source Format",
  "\u6a21\u578b\u540d\uff08HTTP \u8bf7\u6c42\u4f53 / CLI \u7684 <<<MODEL>>>\uff09": "Model Name (HTTP Body / CLI <<<MODEL>>>)",
  "\u6a21\u5f0f": "Mode",
  "\u6b63\u5728\u52a0\u8f7d...": "Loading...",
  "\u6bb5\u4f4d": "Size",
  "\u6bb5\u4f4d\u4ee3\u7801": "Size Code",
  "\u6bcf\u7bb1/\u5305\u7247\u6570": "Pieces per box/pack",
  "\u6bcf\u7bb1\u591a\u5c11\u74f6\uff08\u53ef\u9009\uff09": "Bottles per box (Optional)",
  "\u6dfb\u52a0": "Add",
  "\u6e05\u9664\u5bc6\u6587": "Clear Encrypted Token",
  "\u7528\u6237\u63d0\u793a\u8bcd\u6a21\u677f\uff08\u53ef\u9009\uff0c\u5360\u4f4d\u7b26 {count} {urgent} {urgent_days}\uff09": "User Prompt Template (Optional placeholders)",
  "\u7531\u670d\u52a1\u7aef\u5728": "Generated by server in ",
  "\u7559\u7a7a\u5219\u7528 Node \u8fdb\u7a0b\u5f53\u524d\u76ee\u5f55": "Leave blank for Node cwd",
  "\u7559\u7a7a\u5219\u7528\u5185\u7f6e\u63d0\u793a\u8bcd": "Leave blank for built-in prompts",
  "\u7bb1": "Box",
  "\u7d27\u6025\uff08\u5373\u5c06\u8fc7\u671f\uff09\u65f6\u7684\u6a21\u677f": "Template for Urgent (Expiring)",
  "\u7f8e\u56fd\u6bb5\u8fd0\u5355\u53f7": "US Tracking #",
  "\u81ea\u52a8\u9884\u6d4b\u4ec5\u5305\u542b": "Auto-forecasting only includes ",
  "\u81ea\u5b9a\u4e49\u6a21\u677f": "Custom Template",
  "\u81ea\u5b9a\u4e49\u8bf7\u6c42\u4f53 JSON \u6a21\u677f\uff08\u53ef\u9009\uff09": "Custom Request JSON (Optional)",
  "\u8865\u8d27 \u2014": "Restock \u2014",
  "\u89c4\u683c\uff08\u5c0f\u74f6 2oz / \u5927\u74f6 32oz\uff09": "Spec (Small 2oz / Large 32oz)",
  "\u8ba2\u9605\u5236\u4e91\u7aef\uff1aTODO\uff08\u540e\u7eed\u63a5\u5165\uff09": "Cloud Sub: TODO",
  "\u8bb0\u5f55": "Log",
  "\u8bf4\u660e": "Description",
  "\u8f66\u8f86": "Vehicle",
  "\u8f66\u8f86\u4e0e\u4fdd\u517b\u9879\u76ee\u5b58\u5728": "Vehicles & schedules in",
  "\uff08\u53ef\u8fdb git\uff09\u3002\u81f3\u5c11\u4e00\u8f86\u8f66\u65f6\u663e\u793a\u300c\u517b\u8f66\u300dTab\uff1b\u65f6\u95f4\u8868\u5728\u517b\u8f66\u9875\u7f16\u8f91\u300c\u672c\u6b21\u5df2\u505a\u300d\u3002": " (Git-friendly). Shows 'Car Care' Tab when added.",
  "\uff09\uff0c\u6216\u7531\u670d\u52a1\u7aef\u4ee3\u8c03\u7528\u5927\u6a21\u578b\u751f\u6210\uff08API Key \u4ec5\u5b58\u670d\u52a1\u5668": "), or generated by server LLM (API Key only on server ",
  "\uff0c\u53ef\u70b9\u300c\u672c\u6b21\u5df2\u505a\u300d\u81ea\u52a8\u63a8\u7b97\u4e0b\u6b21\u3002\u652f\u6301\u5bfc\u5165 Carfax / CarCare \u5bfc\u51fa\u7684 CSV\u3002": ", use 'Done' to auto-calculate next. Support Carfax/CarCare export.",
  "\uff1b\u5176\u5b83\u54c1\u7c7b\u9700\u624b\u52a8\u300c\u9700\u8865\u8d27\u300d\u3001\u505a\u83dc\u5f85\u4e70\u6216\u5e93\u5b58\u53f3\u6ed1\u3002\u52fe\u9009\u8981\u663e\u793a\u7684\u6e20\u9053\u5206\u7ec4\uff1b\u5bfc\u51fa Markdown \u4ec5\u5305\u542b\u5f53\u524d\u52fe\u9009\u7684\u6e20\u9053\u3002": "; others need manual selection. Check channels to filter Markdown export.",
  "\uff1b\u9274\u6743\u6539\u4e3a\u300c\u65e0\u300d\u65f6\u53ef\u4e0d\u914d Key\uff08\u5982 Ollama\uff09\u3002": "; Auth=None to skip Key (e.g. Ollama).",
  "\ud83d\udccc \u5e38\u4e70\u98df\u6750": "\ud83d\udccc Frequent Food",
  "\ud83d\udccc \u5e38\u4e70\u98df\u6750\uff08\u9884\u6d4b\u8865\u8d27\u4f1a\u8fdb\u8865\u8d27 Tab\uff09": "\ud83d\udccc Frequent Food (Auto-restock)",
  "\ud83d\udce4 EasyLog \u5bfc\u5165": "\ud83d\udce4 EasyLog Import",
  "\ud83d\udd10 \u5361\u53f7/\u5238\u7801\uff08\u670d\u52a1\u7aef\u52a0\u5bc6\u5b58\u50a8\uff09": "\ud83d\udd10 Encryption Token",
  "\ud83d\uded2 \u6807\u8bb0\u9700\u8865\u8d27\uff08Restock needed\uff09": "\ud83d\uded2 Mark Restock needed",
  "\ud83e\udd16 \u89e3\u6790": "\ud83e\udd16 Parse",

  // New Translations from Feedback
  "储物含食材、衣物、杂物与礼品卡/券码（敏感信息服务端加密）。点击右上角 + 手动录入、扫码或拍照。": "Inventory includes food, clothing, misc, and gift cards/PINs (encrypted). Click + top-right to manually enter, scan, or take a photo.",
  "储物含食材、衣物、杂物与": "Inventory includes food, clothing, misc, and ",
  "礼品卡/券码": "gift cards/PINs",
  "（敏感信息服务端加密）。点击右上角 ": " (encrypted). Click top-right ",
  " 手动录入、扫码或拍照。": " to manually enter, scan, or photo.",
  "右滑条目可快速切换「需补货」（未标常买的食材不会自动进补货预测）。": "Swipe right to mark 'Restock' (Auto-forecast requires 'Frequent' checkmark).",
  "📦 储物清单": "📦 Inventory List",
  "🧊 冰箱冷藏": "🧊 Fridge (Chilled)",
  "❄️ 冷冻": "❄️ Freezer",
  "🗄️ 储物柜": "🗄️ Storage Cabinet",
  "👔 衣柜": "👔 Wardrobe",
  "🧥 衣帽间": "🧥 Closet",
  "🧰 杂物箱": "🧰 Misc Box",
  "🔐 电子保管": "🔐 Digital Vault",
  "宝宝记录快照 (.btcp)": "Baby Log Snapshot (.btcp)",
  "🏠 家用AI": "🏠 Household AI",
  "按渠道与预测补货": "Restock by Channel & Forecast",
  "多记几餐后，这里会显示最常吃的菜": "Log more meals to see your most frequent dishes here",
  "暂无「只差一种食材」的菜谱推荐": "No 'one ingredient away' recipe recommendations yet",
  "今天": "Today",
  "昨天": "Yesterday",
  "喂奶": "Feeding",
  "换尿布": "Diaper Change",
  "生长": "Growth",
  "睡眠(分)": "Sleep (min)",
  "🍼 喂奶": "🍼 Feeding",
  "🩲 换尿布": "🩲 Diaper Change",
  "😴 睡眠": "😴 Sleep",
  "📏 生长": "📏 Growth",
  "🍼 宝宝用品柜": "🍼 Baby Wardrobe",
  "⚠️ 1 件即将过期": "⚠️ 1 item expiring soon",
  "紧急过期": "Urgent Expiry",
  "注意过期": "Expiring Soon",
  "暂无预测": "No Forecast",
  "自动预测仅包含常买食材与 Baby Items；其它品类需手动「需补货」、做菜待买或库存右滑。勾选要显示的渠道分组；导出 Markdown 仅包含当前勾选的渠道。": "Auto-forecast includes Frequent & Baby items; others need manual selection. Check channels to filter Markdown export.",
  "恢复全部渠道": "Reset Channels",
  "导出 Markdown 勾选清单": "Export Markdown Checklist",
  "未设置渠道": "No Channel",
  "尽快": "ASAP",
  "当前库存": "Current Stock",
  "周均": "Weekly Avg",
  "日均": "Daily Avg",
  "约 未知": "Est: Unknown",
  "日": "Sun", "一": "Mon", "二": "Tue", "三": "Wed", "四": "Thu", "五": "Fri", "六": "Sat",
  "加载中…": "Loading...",
  "+ 添加宝宝": "+ Add Baby",
  "暂无记录": "No Records",
  "点击上方按钮开始记录": "Click button above to start logging",
  "集运订单": "Transit Order",
  "国内快递单号": "Domestic Tracking #",
  "上车时间": "Boarding Time",
  "如 2026-03-20 或自由文本": "e.g. 2026-03-20 or text",
  "海运批次": "Shipping Batch",
  "重量": "Weight",
  "保存": "Save",
  "按项目记录上次保养与建议间隔，可点「本次已做」自动推算下次。支持导入 Carfax / CarCare 导出的 CSV。": "Log maintenance schedules & use 'Done' to auto-calculate next. Supports Carfax/CarCare CSV.",
  "📥 从 Carfax / CarCare 导入历史记录": "📥 Import from Carfax / CarCare",
  "上次": "Last",
  "下次（日期）": "Next (Date)",
  "下次（里程）": "Next (Mileage)",
  "机油机滤（小保养）": "Oil Change",
  "刹车油 / 制动液": "Brake Fluid",
  "轮胎换位 / 动平衡": "Tire Rotation / Balance",
  "车辆年检": "Vehicle Inspection",
  "按牌照注册月份": "By License Reg Month",
  "本次已做": "Done"
};

window.t = function(str, fallback) {
  if (!str) return str;
  const lang = getLang();
  if (!lang.startsWith('en')) return str; 

  // Exact match
  if (window.I18N_EN[str]) return window.I18N_EN[str];

  // Try dynamic replacements via regex or function
  if (str.startsWith("✓ ") && str.endsWith(" 已入库！")) {
    const item = str.slice(2, -5);
    return `✓ ${item} added!`;
  }
  if (str.startsWith("❌ ")) {
    const msg = str.slice(2);
    return `❌ ${window.I18N_EN[msg] || msg}`;
  }
  if (str.indexOf("置信度：") > -1) {
    return str.replace('置信度：', 'Confidence: ');
  }
  if (str.endsWith(' 前补')) {
    return str.replace(' 前补', ' Restock by');
  }

  return fallback !== undefined ? fallback : str;
};

// Translates the DOM recursively
window.translateDOM = function(root) {
  if (!root) return;
  const lang = getLang();
  if (!lang.startsWith('en')) return; 

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      let originalText = node.nodeValue;
      let trimmed = originalText.trim();
      if (trimmed && window.I18N_EN[trimmed]) {
        node.nodeValue = originalText.replace(trimmed, window.I18N_EN[trimmed]);
      } else if (trimmed.endsWith(' 前补')) {
        let replaced = trimmed.replace(' 前补', ' Restock by');
        // Because "2026-03-29 前补" has standard space
        node.nodeValue = originalText.replace(trimmed, replaced);
      } else if (trimmed.includes(' 出生 · ') && trimmed.includes('个月') && trimmed.includes('天 · 共 ')) {
        let replaced = trimmed.replace(' 出生 · ', ' Born · ')
                              .replace('个月', 'mo ')
                              .replace('天 · 共 ', 'd · Total ')
                              .replace(' 条记录', ' logs');
        node.nodeValue = originalText.replace(trimmed, replaced);
      }
      
      // Handle remaining dynamic replacements safely
      let nv = node.nodeValue;
      if (nv.match(/(\d+) 件即将过期/)) {
        node.nodeValue = nv.replace(/(\d+) 件即将过期/, "$1 item(s) expiring soon");
      }
      if (nv.match(/还剩 (-?\d+) 天/)) {
        node.nodeValue = nv.replace(/还剩 (-?\d+) 天/, "$1 days left");
      }
      if (nv.match(/约 (.+) 天后耗尽/)) {
        node.nodeValue = nv.replace(/约 (.+) 天后耗尽/, "Est. empty in $1 days");
      }
      if (nv.match(/预测模式：(.+) · 置信度：(.+) · 基于 (.+)/)) {
        let r = nv.replace("预测模式：", "Mode: ")
                  .replace("周均值", "Weekly Avg").replace("日均值", "Daily Avg")
                  .replace(" · 置信度：", " · Conf: ").replace("高", "High")
                  .replace(" · 基于 ", " · Based on ")
                  .replace(" 周数据", " weeks of data")
                  .replace(" 天数据", " days of data");
        node.nodeValue = r;
      }
      if (nv.match(/每 (\d+) 个月 · 每 (\d+) km/)) {
        node.nodeValue = nv.replace(/每 (\d+) 个月 · 每 (\d+) km/, "Every $1 mo · Every $2 km");
      }
      if (nv.match(/每 (\d+) 个月/)) {
        node.nodeValue = nv.replace(/每 (\d+) 个月/, "Every $1 mo");
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      ['placeholder', 'title', 'aria-label', 'alt'].forEach(attr => {
        let v = node.getAttribute(attr);
        if (v && v.trim() && window.I18N_EN[v.trim()]) {
          node.setAttribute(attr, window.I18N_EN[v.trim()]);
        }
      });
      // Specific input value translation
      if (node.tagName === 'INPUT' && (node.type === 'button' || node.type === 'submit')) {
        let v = node.getAttribute('value');
        if (v && v.trim() && window.I18N_EN[v.trim()]) {
          node.setAttribute('value', window.I18N_EN[v.trim()]);
        }
      }
      
      // Select Options standard fallback
      if (node.tagName === 'OPTION') {
        let text = node.textContent.trim();
        if (window.I18N_EN[text]) {
          node.textContent = window.I18N_EN[text];
        }
      }

      node.childNodes.forEach(walk);
    }
  }
  walk(root);
};

document.addEventListener('DOMContentLoaded', () => {
  window.translateDOM(document.body);
  
  // Create language switcher in Settings
  const langSel = document.createElement('div');
  langSel.className = 'form-group';
  langSel.innerHTML = `
    <label class="form-label" data-i18n-skip>🌐 Language (语言)</label>
    <select class="form-select" id="lang-switch" data-i18n-skip>
      <option value="">Auto (Follow Browser)</option>
      <option value="en">English</option>
      <option value="zh">中文</option>
    </select>
  `;
  const setBody = document.getElementById('settings-llm-block');
  if (setBody && setBody.parentNode) {
    setBody.parentNode.insertBefore(langSel, setBody);
  } else {
    document.getElementById('page-settings')?.appendChild(langSel);
  }

  const s = document.getElementById('lang-switch');
  if (s) {
    s.value = localStorage.getItem('lang') || '';
    s.addEventListener('change', (e) => {
      if (e.target.value) {
        localStorage.setItem('lang', e.target.value);
      } else {
        localStorage.removeItem('lang');
      }
      location.reload();
    });
  }

  // React to dynamic DOM updates
  const observer = new MutationObserver((mutations) => {
    let shouldTranslate = false;
    for (let m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        shouldTranslate = true;
        break;
      }
    }
    if (shouldTranslate) {
      observer.disconnect();
      window.translateDOM(document.body);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
});
