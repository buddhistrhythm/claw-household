/**
 * Baby Tracker (.btcp) 导入器
 *
 * 用法（CLI）：
 *   node skills/import-btcp.js <文件路径.btcp> [--dry-run] [--tz=8]
 *
 * 选项：
 *   --dry-run   只打印导入预览，不写入文件
 *   --tz=N      时区偏移（小时，默认 +8 北京时间）
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execSync } = require("child_process");
const Database = require("better-sqlite3");

const BASE_DIR      = path.join(__dirname, "..");
const BABY_LOG_PATH = path.join(BASE_DIR, "data", "baby_log.json");

const OZ_TO_ML   = 29.5735;
const LBS_TO_KG  = 0.453592;
const INCH_TO_CM = 2.54;

// ── 参数解析 ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { file: null, dryRun: false, tz: 8 };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--tz=")) args.tz = parseInt(a.slice(5));
    else if (!a.startsWith("--")) args.file = a;
  }
  return args;
}

// ── 时间戳转 ISO 字符串（本地时区） ──────────────────────────────────────────

function tsToISO(unixSec, tzOffset) {
  const ms = (unixSec + tzOffset * 3600) * 1000;
  const d  = new Date(ms);
  // 手动格式化为 YYYY-MM-DDTHH:MM:SS（不带时区后缀，表示本地时间）
  const pad = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}` +
         `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function tsToDate(unixSec, tzOffset) {
  return tsToISO(unixSec, tzOffset).split("T")[0];
}

// ── 事件 ID 生成 ─────────────────────────────────────────────────────────────

function makeEventId(type, unixSec) {
  return `btcp_${type}_${Math.round(unixSec)}`;
}

// ── 核心导入 ─────────────────────────────────────────────────────────────────

function importBtcp(btcpPath, { dryRun = false, tz = 8 } = {}) {
  // 1. 解压到临时目录
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "btcp_"));
  try {
    execSync(`unzip -o "${btcpPath}" -d "${tmpDir}"`, { stdio: "pipe" });
  } catch (e) {
    throw new Error(`解压失败：${e.message}`);
  }

  const dbPath = path.join(tmpDir, "EasyLog.db");
  if (!fs.existsSync(dbPath)) {
    fs.rmSync(tmpDir, { recursive: true });
    throw new Error("btcp 文件中未找到 EasyLog.db");
  }

  const db = new Database(dbPath, { readonly: true });

  // 2. 读取宝宝信息
  const babies = db.prepare("SELECT * FROM Baby").all();
  if (babies.length === 0) throw new Error("数据库中没有宝宝信息");

  const baby = babies[0];
  const babyName = baby.Name;
  const babyDob  = baby.DOB ? tsToDate(baby.DOB, tz) : null;
  const babyGender = baby.Gender === 0 ? "female" : "male";

  console.log(`\n👶 宝宝：${babyName}（${babyGender}）  出生：${babyDob}`);

  // 3. 读取现有日志（用于去重）
  let babyLog = { version: "1.0", events: [] };
  if (fs.existsSync(BABY_LOG_PATH)) {
    babyLog = JSON.parse(fs.readFileSync(BABY_LOG_PATH, "utf-8"));
  }
  const existingIds = new Set(babyLog.events.map(e => e.id));

  const newEvents = [];
  let skipped = 0;

  function addEvent(id, type, unixSec, data) {
    if (existingIds.has(id)) { skipped++; return; }
    newEvents.push({ id, type, time: tsToISO(unixSec, tz), data });
  }

  // ── Diaper ──────────────────────────────────────────────────────────────
  const diaperStatusMap = { 0: "wet", 1: "dirty", 2: "wet_and_dirty" };
  const diapers = db.prepare("SELECT * FROM Diaper ORDER BY Time ASC").all();
  for (const r of diapers) {
    addEvent(makeEventId("diaper", r.Time), "diaper", r.Time, {
      status: diaperStatusMap[r.Status] ?? "unknown",
      note: r.Note || null,
    });
  }
  console.log(`  📊 Diaper: ${diapers.length} 条`);

  // ── Formula（奶瓶喂奶） ──────────────────────────────────────────────────
  const feedDescs = {};
  for (const fd of db.prepare("SELECT ID, Name FROM FeedDesc").all()) {
    feedDescs[fd.ID] = fd.Name;
  }

  const formulas = db.prepare("SELECT * FROM Formula ORDER BY Time ASC").all();
  for (const r of formulas) {
    const amountMl = r.IsEnglishScale === 1
      ? Math.round(r.Amount * OZ_TO_ML * 10) / 10
      : r.Amount;
    addEvent(makeEventId("formula", r.Time), "feeding_bottle", r.Time, {
      amount_ml: amountMl,
      note: r.Note || null,
      reaction: r.DescID ? (feedDescs[r.DescID] || null) : null,
    });
  }
  console.log(`  📊 Formula: ${formulas.length} 条`);

  // ── Nursing（母乳） ──────────────────────────────────────────────────────
  const nursings = db.prepare("SELECT * FROM Nursing ORDER BY Time ASC").all();
  for (const r of nursings) {
    const totalSec = (r.LeftDuration || 0) + (r.RightDuration || 0) + (r.BothDuration || 0);
    addEvent(makeEventId("nursing", r.Time), "feeding_nursing", r.Time, {
      left_sec:  r.LeftDuration  || 0,
      right_sec: r.RightDuration || 0,
      both_sec:  r.BothDuration  || 0,
      total_min: Math.round(totalSec / 60 * 10) / 10,
      note: r.Note || null,
    });
  }
  if (nursings.length) console.log(`  📊 Nursing: ${nursings.length} 条`);

  // ── OtherFeed（辅食） ────────────────────────────────────────────────────
  const otherFeedDescs = {};
  for (const fd of db.prepare("SELECT ID, Name FROM OtherFeedSelection").all()) {
    otherFeedDescs[fd.ID] = fd.Name;
  }

  const otherFeeds = db.prepare("SELECT * FROM OtherFeed ORDER BY Time ASC").all();
  for (const r of otherFeeds) {
    addEvent(makeEventId("otherfeed", r.Time), "feeding_solid", r.Time, {
      food: r.DescID ? (otherFeedDescs[r.DescID] || "unknown") : "unknown",
      amount_ml: r.Amount || null,
      note: r.Note || null,
    });
  }
  if (otherFeeds.length) console.log(`  📊 OtherFeed: ${otherFeeds.length} 条`);

  // ── Sleep ────────────────────────────────────────────────────────────────
  const sleeps = db.prepare("SELECT * FROM Sleep ORDER BY Time ASC").all();
  for (const r of sleeps) {
    addEvent(makeEventId("sleep", r.Time), "sleep", r.Time, {
      duration_min: r.Duration || 0,
      note: r.Note || null,
    });
  }
  if (sleeps.length) console.log(`  📊 Sleep: ${sleeps.length} 条`);

  // ── Growth ───────────────────────────────────────────────────────────────
  const growths = db.prepare("SELECT * FROM Growth ORDER BY Time ASC").all();
  for (const r of growths) {
    const weight = r.Weight > 0
      ? (r.IsEnglishWeightScale === 1 ? Math.round(r.Weight * LBS_TO_KG * 1000) / 1000 : Math.round(r.Weight * 1000) / 1000)
      : null;
    const length = r.Length > 0
      ? (r.IsEnglishLengthScale === 1 ? Math.round(r.Length * INCH_TO_CM * 10) / 10 : r.Length)
      : null;
    const head = r.Head > 0
      ? (r.IsEnglishLengthScale === 1 ? Math.round(r.Head * INCH_TO_CM * 10) / 10 : r.Head)
      : null;
    addEvent(makeEventId("growth", r.Time), "growth", r.Time, {
      weight_kg: weight,
      length_cm: length,
      head_cm:   head,
      note: r.Note || null,
    });
  }
  if (growths.length) console.log(`  📊 Growth: ${growths.length} 条`);

  // ── Milestone ────────────────────────────────────────────────────────────
  const milestoneNames = {};
  for (const m of db.prepare("SELECT ID, Name FROM MilestoneSelection").all()) {
    milestoneNames[m.ID] = m.Name;
  }

  const milestones = db.prepare("SELECT * FROM Milestone ORDER BY Time ASC").all();
  for (const r of milestones) {
    addEvent(makeEventId("milestone", r.Time), "milestone", r.Time, {
      name: milestoneNames[r.MilestoneSelectionID] || "Unknown milestone",
      note: r.Note || null,
    });
  }
  if (milestones.length) console.log(`  📊 Milestone: ${milestones.length} 条`);

  // ── Medicine / Bath / DoctorVisit ────────────────────────────────────────
  for (const [table, type] of [["Medicine","medicine"], ["Bath","bath"], ["DoctorVisit","doctor_visit"]]) {
    try {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY Time ASC`).all();
      for (const r of rows) {
        addEvent(makeEventId(type, r.Time), type, r.Time, { note: r.Note || null });
      }
      if (rows.length) console.log(`  📊 ${table}: ${rows.length} 条`);
    } catch (_) {}
  }

  db.close();
  fs.rmSync(tmpDir, { recursive: true });

  // 按时间排序
  newEvents.sort((a, b) => a.time.localeCompare(b.time));

  // 4. 统计 & 预览
  const typeCount = {};
  for (const e of newEvents) typeCount[e.type] = (typeCount[e.type] || 0) + 1;

  console.log(`\n✅ 将导入 ${newEvents.length} 条新记录（跳过已存在 ${skipped} 条）`);
  for (const [type, count] of Object.entries(typeCount)) {
    console.log(`   ${type}: ${count}`);
  }

  if (newEvents.length === 0) {
    console.log("⚠️  没有新数据，已是最新。");
    return { imported: 0, skipped };
  }

  if (dryRun) {
    console.log("\n（--dry-run 模式，未写入文件）");
    console.log("\n前 3 条记录预览：");
    newEvents.slice(0, 3).forEach(e => console.log(" ", JSON.stringify(e, null, 2)));
    return { imported: 0, skipped, preview: newEvents.slice(0, 3) };
  }

  // 5. 写入 baby_log.json（追加 + 按时间排序）
  babyLog.events = [...babyLog.events, ...newEvents]
    .sort((a, b) => a.time.localeCompare(b.time));

  // 同步更新宝宝基本信息
  if (!babyLog.baby) {
    babyLog.baby = { name: babyName, dob: babyDob, gender: babyGender };
    console.log(`\n💾 写入宝宝基本信息：${babyName}`);
  }

  fs.writeFileSync(BABY_LOG_PATH, JSON.stringify(babyLog, null, 2));
  console.log(`\n💾 已写入 ${BABY_LOG_PATH}`);
  console.log(`   总事件数：${babyLog.events.length}`);

  return { imported: newEvents.length, skipped, total: babyLog.events.length };
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.log("用法：node skills/import-btcp.js <file.btcp> [--dry-run] [--tz=8]");
    process.exit(1);
  }
  if (!fs.existsSync(args.file)) {
    console.error(`文件不存在：${args.file}`);
    process.exit(1);
  }
  try {
    importBtcp(args.file, { dryRun: args.dryRun, tz: args.tz });
  } catch (e) {
    console.error("❌ 导入失败：", e.message);
    process.exit(1);
  }
}

module.exports = { importBtcp };
