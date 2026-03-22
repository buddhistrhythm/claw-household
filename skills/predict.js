/**
 * 消耗预测模块
 *
 * 规则：
 *  - 历史跨度 >= 7天  → 按周汇总，取周均值，再折算日均
 *  - 历史跨度 <  7天  → 按天汇总，取日均值
 *  - 无消耗记录       → mode=none，无法预测
 *
 * 置信度：
 *  - high   : 周模式且 >= 4 周数据
 *  - medium : 周模式 1-3 周，或日模式 >= 3 天
 *  - low    : 日模式 1-2 天
 */

const MS_DAY = 86400_000;

/**
 * 将 YYYY-MM-DD 转成 Date（本地 0:00）
 */
function parseDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 将本地 Date 格式化为 YYYY-MM-DD（不用 toISOString，避免 UTC 偏移）
 */
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 将 YYYY-MM-DD 前进 N 个日历天（用 setDate，正确处理月末/DST）
 */
function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

/**
 * 获取某日期所在的 ISO 周开始（周一），返回 YYYY-MM-DD
 */
function isoWeekStart(dateStr) {
  const d = parseDate(dateStr);
  const day = d.getDay() || 7; // 1=Mon … 7=Sun
  d.setDate(d.getDate() - day + 1);
  return formatDate(d);
}

/**
 * 计算今天到某日的天数差（正数=未来，负数=过去）
 */
function daysFromNow(dateStr) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((parseDate(dateStr) - now) / MS_DAY);
}

/**
 * 从 growth 事件构建按日去重后的体重时间序列（按日期升序）
 */
function buildGrowthWeightSeries(babyEvents) {
  if (!babyEvents || !babyEvents.length) return [];
  const byDate = {};
  for (const e of babyEvents) {
    if (e.type !== "growth") continue;
    const w = e.data?.weight_kg;
    if (w == null || w <= 0) continue;
    const date = (e.time || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byDate[date] = w;
  }
  return Object.keys(byDate)
    .sort()
    .map((date) => ({ date, weight: byDate[date] }));
}

/**
 * 某日宝宝体重：取该日期及之前最近一次生长记录的体重（carry-forward）
 */
function weightKgOnDateCarryForward(series, dateStr) {
  if (!series.length) return null;
  let last = null;
  for (const p of series) {
    if (p.date <= dateStr) last = p.weight;
    else break;
  }
  if (last != null) return last;
  return series[0].weight;
}

function matchesDiaperWeightRange(weightKg, spec) {
  if (weightKg == null || weightKg <= 0) return false;
  if (!spec || spec.weight_min_kg == null || spec.weight_max_kg == null) return false;
  return weightKg >= spec.weight_min_kg && weightKg <= spec.weight_max_kg;
}

/**
 * 从宝宝日志生成「虚拟」消耗记录（与库存单位对齐）
 * - diaper：每日换尿布次数 → 片；若库存含 diaper_spec，则仅统计「当时体重」落在该 SKU 段位内的换尿布
 * - formula：每日冲调奶量 ml → 克（ml / formula_ml_per_gram）；排除 milk_type=ready_to_feed（及旧值 water_milk）
 * - ready_to_feed（水奶）：仅 milk_type=ready_to_feed（或旧 water_milk）；库存单位为瓶；2oz 向上取整瓶，32oz 可有小数
 */
function buildBabyDerivedRecords(item, babyEvents, prefs) {
  if (!babyEvents || !babyEvents.length) return [];
  const b = prefs?.baby || {};
  const track = b._resolved_track || {};
  const configured = b.track_item_ids || {};

  if (item.category === "diaper") {
    const growthSeries = buildGrowthWeightSeries(babyEvents);
    const hasTierSpec =
      item.diaper_spec &&
      item.diaper_spec.weight_min_kg != null &&
      item.diaper_spec.weight_max_kg != null;

    if (!hasTierSpec) {
      const targetId = configured.diaper || track.diaper;
      if (!targetId || targetId !== item.id) return [];
    }

    const perChange = b.diaper_qty_per_change ?? 1;
    const byDay = {};
    for (const e of babyEvents) {
      if (e.type !== "diaper") continue;
      const date = (e.time || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      if (hasTierSpec) {
        const w = weightKgOnDateCarryForward(growthSeries, date);
        if (!matchesDiaperWeightRange(w, item.diaper_spec)) continue;
      } else if ((configured.diaper || track.diaper) !== item.id) {
        continue;
      }

      byDay[date] = (byDay[date] || 0) + perChange;
    }
    return Object.entries(byDay).map(([date, qty]) => ({
      item_id: item.id,
      item_name: item.name,
      category: item.category,
      date,
      qty,
      unit: item.unit,
      note: "baby_log",
    }));
  }

  if (item.category === "formula") {
    const targetId = configured.formula || track.formula;
    if (!targetId || targetId !== item.id) return [];
    const mlPerG = b.formula_ml_per_gram ?? 7;
    if (mlPerG <= 0) return [];
    const byDay = {};
    for (const e of babyEvents) {
      if (e.type !== "feeding_bottle") continue;
      const mt = e.data?.milk_type;
      if (mt === "ready_to_feed" || mt === "water_milk") continue;
      const ml = e.data?.amount_ml;
      if (ml == null || ml <= 0) continue;
      const date = (e.time || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const g = ml / mlPerG;
      byDay[date] = (byDay[date] || 0) + g;
    }
    return Object.entries(byDay).map(([date, qty]) => ({
      item_id: item.id,
      item_name: item.name,
      category: item.category,
      date,
      qty: Math.round(qty * 100) / 100,
      unit: item.unit,
      note: "baby_log",
    }));
  }

  const isRtfCategory = item.category === "ready_to_feed" || item.category === "water_milk";
  if (isRtfCategory) {
    const targetId =
      configured.ready_to_feed ||
      configured.water_milk ||
      track.ready_to_feed ||
      track.water_milk;
    if (!targetId || targetId !== item.id) return [];
    const spec = item.ready_to_feed_spec || item.water_milk_spec || {};
    const mlPerBottle =
      spec.ml_per_bottle != null && spec.ml_per_bottle > 0
        ? Number(spec.ml_per_bottle)
        : spec.grams_per_bottle != null && spec.grams_per_bottle > 0
          ? Number(spec.grams_per_bottle)
          : null;
    if (mlPerBottle == null || mlPerBottle <= 0) return [];
    const useCeil = spec.bottle_format !== "large_32oz";
    const byDay = {};
    for (const e of babyEvents) {
      if (e.type !== "feeding_bottle") continue;
      const mt = e.data?.milk_type;
      if (mt !== "ready_to_feed" && mt !== "water_milk") continue;
      const ml = e.data?.amount_ml;
      if (ml == null || ml <= 0) continue;
      const date = (e.time || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const bottles = useCeil ? Math.ceil(ml / mlPerBottle) : ml / mlPerBottle;
      byDay[date] = (byDay[date] || 0) + bottles;
    }
    return Object.entries(byDay).map(([date, qty]) => ({
      item_id: item.id,
      item_name: item.name,
      category: item.category,
      date,
      qty: Math.round(qty * 1000) / 1000,
      unit: item.unit,
      note: "baby_log",
    }));
  }

  return [];
}

function diaperBabyMeta(item, babyEvents) {
  if (item.category !== "diaper" || !babyEvents?.length) return null;
  const spec = item.diaper_spec;
  const series = buildGrowthWeightSeries(babyEvents);
  if (!series.length) {
    return {
      has_growth: false,
      latest_weight_kg: null,
      weight_for_today_kg: null,
      in_current_segment: spec?.weight_min_kg != null ? false : null,
      segment: spec
        ? {
            code: spec.segment_code,
            label: spec.segment_label || spec.segment_code,
            weight_min_kg: spec.weight_min_kg,
            weight_max_kg: spec.weight_max_kg,
          }
        : null,
    };
  }
  const latest = series[series.length - 1];
  const todayStr = formatDate(new Date());
  const wToday = weightKgOnDateCarryForward(series, todayStr);
  return {
    has_growth: true,
    latest_weight_kg: Math.round(latest.weight * 100) / 100,
    weight_for_today_kg: wToday != null ? Math.round(wToday * 100) / 100 : null,
    in_current_segment: spec?.weight_min_kg != null ? matchesDiaperWeightRange(wToday, spec) : null,
    segment: spec
      ? {
          code: spec.segment_code,
          label: spec.segment_label || spec.segment_code,
          weight_min_kg: spec.weight_min_kg,
          weight_max_kg: spec.weight_max_kg,
        }
      : null,
  };
}

function attachDiaperMeta(base, item, babyEvents) {
  if (item.category !== "diaper") return base;
  return { ...base, diaper_baby_meta: diaperBabyMeta(item, babyEvents) };
}

/**
 * 主预测函数
 *
 * @param {object} item          - inventory 中的 item 对象
 * @param {Array}  allRecords    - consumption_history.json 中的 records 数组
 * @param {object} prefs         - preferences.json 对象（可含 baby._resolved_track）
 * @param {Array|null} babyEvents - baby_log.json 的 events（可选）
 * @returns {object}             - 预测结果
 */
function predict(item, allRecords, prefs, babyEvents = null) {
  const deliveryDays = prefs?.shopping?.delivery_days ?? 1;

  const noPredictCats = new Set(["digital_voucher", "clothing", "home_misc"]);
  if (noPredictCats.has(item.category)) {
    return attachDiaperMeta(
      {
        mode: "none",
        confidence: "none",
        message: "该品类不做自动消耗预测",
        sources: { consumption_history: false, baby_log: false },
      },
      item,
      babyEvents
    );
  }

  // 匹配规则：同 item_id 或同 name+category（跨批次追踪同类商品）
  const historyRecords = allRecords.filter(
    (r) =>
      r.item_id === item.id ||
      (r.item_name === item.name && r.category === item.category)
  );

  const babyRecords = buildBabyDerivedRecords(item, babyEvents, prefs);
  const records = [...historyRecords, ...babyRecords];

  const usedBabyLog = babyRecords.length > 0;
  const usedHistory = historyRecords.length > 0;

  if (records.length === 0) {
    return attachDiaperMeta(
      {
        mode: "none",
        confidence: "none",
        message: "暂无消耗记录",
        sources: { consumption_history: false, baby_log: false },
      },
      item,
      babyEvents
    );
  }

  // 按日期排序
  records.sort((a, b) => a.date.localeCompare(b.date));
  const firstDate = records[0].date;
  const lastDate = records[records.length - 1].date;
  const historyDays =
    Math.round((parseDate(lastDate) - parseDate(firstDate)) / MS_DAY) + 1;

  // ── 按天汇总 ──────────────────────────────────────────────────────────────
  const byDay = {};
  for (const r of records) {
    byDay[r.date] = (byDay[r.date] || 0) + r.qty;
  }

  if (historyDays < 7) {
    // ── 日模式 ──────────────────────────────────────────────────────────────
    const totalConsumed = Object.values(byDay).reduce((s, v) => s + v, 0);
    const avgDaily = totalConsumed / historyDays; // 含无消耗天也参与平均
    const confidence = historyDays >= 3 ? "medium" : "low";

    const breakdown = buildDailyBreakdown(byDay, firstDate, lastDate);

    return attachDiaperMeta(
      {
        ...buildResult({
          mode: "daily",
          confidence,
          historyDays,
          avgDaily,
          breakdown,
          item,
          deliveryDays,
        }),
        sources: {
          consumption_history: usedHistory,
          baby_log: usedBabyLog,
        },
      },
      item,
      babyEvents
    );
  } else {
    // ── 周模式 ──────────────────────────────────────────────────────────────
    const byWeek = {};
    for (const [dateStr, qty] of Object.entries(byDay)) {
      const ws = isoWeekStart(dateStr);
      byWeek[ws] = (byWeek[ws] || 0) + qty;
    }

    // 填充区间内所有完整周（含 0 消耗周）— 用字符串步进，不受 DST 影响
    const startWeek = isoWeekStart(firstDate);
    const endWeek   = isoWeekStart(lastDate);
    const allWeeks = [];
    let cursorWeek = startWeek;
    while (cursorWeek <= endWeek) {
      allWeeks.push({ week: cursorWeek, qty: byWeek[cursorWeek] || 0 });
      cursorWeek = addDays(cursorWeek, 7);
    }

    const totalConsumed = allWeeks.reduce((s, w) => s + w.qty, 0);
    const avgWeekly = totalConsumed / allWeeks.length;
    const avgDaily  = avgWeekly / 7;

    const numWeeks = allWeeks.length;
    const confidence =
      numWeeks >= 4 ? "high" : numWeeks >= 2 ? "medium" : "low";

    return attachDiaperMeta(
      {
        ...buildResult({
          mode: "weekly",
          confidence,
          historyDays,
          numWeeks,
          avgWeekly,
          avgDaily,
          breakdown: allWeeks,
          item,
          deliveryDays,
        }),
        sources: {
          consumption_history: usedHistory,
          baby_log: usedBabyLog,
        },
      },
      item,
      babyEvents
    );
  }
}

// ─── 辅助：构建日明细（含空日）────────────────────────────────────────────────

function buildDailyBreakdown(byDay, firstDate, lastDate) {
  const days = [];
  let cursorDate = firstDate;
  while (cursorDate <= lastDate) {
    days.push({ date: cursorDate, qty: byDay[cursorDate] || 0 });
    cursorDate = addDays(cursorDate, 1);
  }
  return days;
}

// ─── 辅助：组装最终结果 ───────────────────────────────────────────────────────

function buildResult({ mode, confidence, historyDays, numWeeks, avgWeekly, avgDaily, breakdown, item, deliveryDays }) {
  const daysUntilEmpty =
    avgDaily > 0 ? item.quantity / avgDaily : null;

  let estimatedEmptyDate = null;
  let restockDate        = null;
  let restockUrgency     = "normal"; // normal / soon / urgent / overdue

  if (daysUntilEmpty !== null) {
    estimatedEmptyDate = addDays(formatDate(new Date()), Math.round(daysUntilEmpty));
    restockDate        = addDays(estimatedEmptyDate, -deliveryDays);

    const restockIn = daysFromNow(restockDate);
    if (restockIn < 0)       restockUrgency = "overdue";
    else if (restockIn <= 1) restockUrgency = "urgent";
    else if (restockIn <= 3) restockUrgency = "soon";
    else                     restockUrgency = "normal";
  }

  return {
    mode,            // "daily" | "weekly" | "none"
    confidence,      // "high" | "medium" | "low" | "none"
    history_days: historyDays,
    num_weeks:    numWeeks ?? null,
    avg_daily:    avgDaily  != null ? Math.round(avgDaily  * 100) / 100 : null,
    avg_weekly:   avgWeekly != null ? Math.round(avgWeekly * 100) / 100 : null,
    days_until_empty:     daysUntilEmpty != null ? Math.round(daysUntilEmpty * 10) / 10 : null,
    estimated_empty_date: estimatedEmptyDate,
    restock_date:         restockDate,
    restock_urgency:      restockUrgency,
    breakdown,       // daily: [{date, qty}]  weekly: [{week, qty}]
  };
}

module.exports = {
  predict,
  buildBabyDerivedRecords,
  buildGrowthWeightSeries,
  weightKgOnDateCarryForward,
  matchesDiaperWeightRange,
};
