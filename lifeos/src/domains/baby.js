'use strict';

/**
 * baby.js — 宝宝档案与「为什么哭」推断（baby profile + transparent cry inference）.
 *
 * 一个宝宝是一条实体（type=baby）。宝宝的生活事件复用 life_event 类型，
 * 通过两条线索关联到宝宝：
 *   event -[for_baby]-> baby       一等公民边（first-class edge，单值，relations.replace）
 *   data.baby_id = <baby entity id> 数据字段（与旧 baby_log.json 互通 / legacy interop）
 *
 * A baby is an entity (type=baby). Its life events reuse the `life_event`
 * type and bind to the baby via BOTH a `for_baby` edge and `data.baby_id`
 * — the edge gives us cheap SQL joins, the data field keeps round-trips
 * with the legacy household importer (which stores baby_id in JSONB).
 *
 * 推断「为什么哭」是确定性、可解释的：每个候选都带 signals 数组，
 * 每个 signal 有数字证据（value, benchmark, weight）。打分公式集中在
 * 顶部 SCORING 常量里，UI 渲染时直接读 signals[]，不调 LLM。
 * The cry inferer is deterministic and transparent: each candidate
 * carries a `signals[]` array — every signal contains a number, a
 * benchmark, and a weight — so the UI can render "why" with evidence.
 * The scoring weights live in the SCORING constant at the top so they
 * are tune-able in one place; no LLM is ever called.
 */

const FOR_BABY = 'for_baby';
const VERBS = { FEED: 'feed', DIAPER: 'diaper_change', SLEEP: 'sleep', FUSSY: 'fussy' };

// ─── 月龄→典型清醒时长（min）的查表 / wake-window lookup table ────────────────
// 数字来源：常见育儿手册经验值（pediatric "wake window" guidance）。
// 月龄递增，找到第一个上限即返回；都不命中走 default 240（接近 4 小时）。
const WAKE_WINDOW_TABLE = [
  { max_months: 1,  minutes: 50 },
  { max_months: 2,  minutes: 60 },
  { max_months: 4,  minutes: 75 },
  { max_months: 6,  minutes: 90 },
  { max_months: 9,  minutes: 120 },
  { max_months: 12, minutes: 150 },
  { max_months: 18, minutes: 180 },
];
const WAKE_WINDOW_DEFAULT = 240;

// ─── SCORING constants（评分常量，集中在此便于调参）─────────────────────────
// 每个常量都用中英双语解释其物理含义；改这些数字就改打分行为，不要改公式。
// Every weight is documented; tweak the numbers here, not the formulas below.
const SCORING = {
  // 饿了 / HUNGRY
  // 经验间隔：0–6 月按 3 小时（180min），>=6 月按 4 小时（240min）。
  // typical_feed_interval used as denominator for "how close to next feed".
  HUNGRY_INTERVAL_MIN_UNDER_6MO: 180,
  HUNGRY_INTERVAL_MIN_OVER_6MO: 240,
  // 上一顿量明显偏少（< 80% 均值）→ 这一次饿得更快，加 0.2 分。
  // Bonus if the last feed was clearly small vs recent average.
  HUNGRY_SMALL_LAST_FEED_THRESHOLD: 0.8,
  HUNGRY_SMALL_LAST_FEED_BONUS: 0.2,

  // 困了 / SLEEPY
  // 用宝宝月龄查 wake-window；越接近/超出 → 越困。
  // wake-window comes from per-baby override OR the WAKE_WINDOW_TABLE.
  // 上一觉非常短（<30min，没睡好）→ 这次更困，加 0.2。
  SLEEPY_SHORT_NAP_MAX_MIN: 30,
  SLEEPY_SHORT_NAP_BONUS: 0.2,

  // 要换尿布 / WET
  // 典型换尿布间隔 150 分钟（2.5h）；接近/超出 → 该换了。
  // typical_diaper_interval = WET_INTERVAL_MIN as denominator.
  WET_INTERVAL_MIN: 150,
  // 刚拉过 dirty（< 30min）→ 几乎不可能再立刻要换；wet 分接近 0。
  // If the last change was a dirty one very recently, near-zero out wet.
  WET_RECENT_DIRTY_SUPPRESS_MIN: 30,

  // 想玩 / PLAY
  // base = (1 - max(其他三项)) * min(1, awake/wake_window)
  // 没有附加常量；定义就在 computePlayBase 里。

  // 共用 / shared
  // 所有 base = clamp((ratio) - 0.5, 0, 1) 的「半程偏置」/ half-curve offset:
  // 这样 ratio<=0.5 时分数为 0（还不到典型间隔的一半，没理由哭这个原因）。
  // The -0.5 offset means "until you reach half the typical interval,
  // this reason scores 0" — a reason needs evidence to count.
  BASE_HALF_OFFSET: 0.5,
};

// ─── PERSONAL_BASELINE constants（个人基线常量）─────────────────────────────
// 用过去一段时间这个宝宝自己的数据，覆盖群体经验值表。样本不够时回退到表。
// Use the baby's own recent history to override the age-table defaults.
// When sample_size < required_*, we fall back to the table.
const PERSONAL_BASELINE = {
  // 看多久的历史：默认 7 天 / lookback used ONLY for baselines.
  HOURS: 24 * 7,
  // 最少样本量：少于此就不用个人基线 / minimum samples required to trust personal data.
  MIN_FEED_SAMPLES: 5,
  MIN_WAKE_SAMPLES: 5,
  MIN_DIAPER_SAMPLES: 5,
  // 取最近 N 个间隔参与中位数 / cap the most recent samples used for the median.
  MAX_FEED_SAMPLES: 20,
  MAX_WAKE_SAMPLES: 10,
  MAX_DIAPER_SAMPLES: 20,
};

// ─── PATTERN constants（时间-of-day 圈昼夜节律层 / circadian pattern layer）─
// 比较过去 N 天每天「在同一时间点」附近的事件分布；命中率高就是该宝宝的节律。
// Compare the same clock-time across the prior N days. A high hit ratio
// at this hour-of-day is THIS baby's circadian pattern — strong evidence.
const PATTERN = {
  // 看过去多少天 / lookback window in days.
  DAYS: 7,
  // 同一时刻的容忍窗（分钟）/ ±tolerance window around the same clock-time.
  WINDOW_MIN: 30,
  // 命中比例阈值：days_with_hit / days_with_data >= 此值才出信号。
  // hit ratio threshold for emitting a pattern signal.
  HIT_RATIO: 0.6,
  // 至少有这么多天的数据才参与判断 / minimum days with ANY data to qualify.
  MIN_DAYS: 4,
  // 命中目标 verb 的正向加分 / positive bonus added to a matching candidate.
  POSITIVE_WEIGHT: 0.2,
  // 命中其它 verb（说明此时通常不饿/不困）的负向减分 / negative penalty.
  NEGATIVE_WEIGHT: -0.1,
};

// ─── TREND constants（趋势 / 哭前积聚层 / pre-cry build-up layer）─────────
// 看哭之前那一小段时间正在发生的事情：哼唧、喂量下降、严重超 wake-window。
// "What's been building up in the last hour?" — fussy episodes, decreasing
// feed volumes, blown-past wake window. Negative signals are surfaced too.
const TREND = {
  // 找 fussy 事件的回看窗口（分钟）/ how far back to look for fussy events.
  FUSSY_LOOKBACK_MIN: 60,
  // 多少次 fussy 才算积聚 / how many fussy events trigger the bonus.
  FUSSY_THRESHOLD: 2,
  // 触发后给 SLEEPY 的加分 / SLEEPY bonus when threshold crossed.
  FUSSY_WEIGHT: 0.15,
  // 最近 3 次喂量单调下降 → 「不是真饿」/ monotone decreasing last 3 feeds.
  FEED_DECREASE_WEIGHT: -0.1,
  // wake 超过 wake_window 的倍数阈值 / overtime multiplier.
  OVERTIME_MULTIPLIER: 1.5,
  // 触发后给 SLEEPY 的加分 / SLEEPY bonus when minutes_since_wake > k * window.
  OVERTIME_WEIGHT: 0.2,
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;
const MONTH_DAYS = 30.4375; // 365.25 / 12

/** Coerce date-ish to Date. Accepts Date | ISO string | null/undefined. */
function asDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Floating-point months between birth and `at`. */
function ageMonths(birth_date, at = new Date()) {
  const b = asDate(birth_date);
  const a = asDate(at) || new Date();
  if (!b) return null;
  return (a.getTime() - b.getTime()) / DAY_MS / MONTH_DAYS;
}

/** Table-driven wake-window for this baby's age. */
function wakeWindowMin(birth_date, at = new Date()) {
  const months = ageMonths(birth_date, at);
  if (months == null) return WAKE_WINDOW_DEFAULT;
  for (const row of WAKE_WINDOW_TABLE) {
    if (months < row.max_months) return row.minutes;
  }
  return WAKE_WINDOW_DEFAULT;
}

/** Clamp a number into [lo, hi]. */
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Round to 3 decimals (scores stay readable). */
function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Median of a numeric array. Mutates a copy (sort). Returns null on empty. */
function median(arr) {
  const xs = arr.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Inter-arrival gaps (minutes) between consecutive timestamped events,
 * sorted by occurred_at ASC. Returns at most `cap` MOST RECENT gaps.
 */
function recentGapsMin(events, cap) {
  const asc = events
    .map((e) => asDate(e.occurred_at))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  const gaps = [];
  for (let i = 1; i < asc.length; i += 1) {
    gaps.push((asc[i].getTime() - asc[i - 1].getTime()) / 60000);
  }
  return gaps.slice(-Math.max(1, cap | 0));
}

/**
 * Wake-period gaps (minutes) — between (sleep.start + duration_min) and the
 * NEXT sleep start. Returns the most recent `cap` gaps.
 * Inputs: sleeps sorted any order; we sort ASC internally.
 */
function recentWakeWindowsMin(sleeps, cap) {
  const asc = sleeps
    .filter((e) => asDate(e.occurred_at))
    .slice()
    .sort((a, b) => asDate(a.occurred_at).getTime() - asDate(b.occurred_at).getTime());
  const gaps = [];
  for (let i = 1; i < asc.length; i += 1) {
    const prev = asc[i - 1];
    const next = asc[i];
    const prevStart = asDate(prev.occurred_at).getTime();
    const dur = Number(prev.data && prev.data.duration_min) || 0;
    const wokeAt = prevStart + dur * 60000;
    const nextStart = asDate(next.occurred_at).getTime();
    const gap = (nextStart - wokeAt) / 60000;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  return gaps.slice(-Math.max(1, cap | 0));
}

/**
 * Time-of-day pattern: count days (over the last PATTERN_DAYS days, NOT
 * counting today) where there is at least one event of `verb` within
 * ±PATTERN.WINDOW_MIN of `at`'s clock-of-day.
 *
 * Returns { days_with_data, days_with_hit, ratio, hits_total }.
 */
function timeOfDayHits(events, at, verb) {
  const atDate = asDate(at) || new Date();
  const atMs = atDate.getTime();
  const W = PATTERN.WINDOW_MIN * 60000;
  // We bucket events by "day offset" (1..PATTERN_DAYS) relative to today.
  // day offset = floor((at - event.occurred_at) / DAY_MS), only counting offsets in [1..DAYS].
  const daysWithData = new Set();
  const daysWithHit = new Set();
  let hitsTotal = 0;
  for (const e of events) {
    const d = asDate(e.occurred_at);
    if (!d) continue;
    const deltaMs = atMs - d.getTime();
    if (deltaMs <= 0) continue;
    const offset = Math.floor(deltaMs / DAY_MS) + 1; // event from yesterday → offset=1
    if (offset < 1 || offset > PATTERN.DAYS) continue;
    daysWithData.add(offset);
    // Same-clock comparison: compare the event's clock-time to at's clock-time.
    // We do this by SHIFTING the event forward by `offset` whole days and
    // measuring |shifted - at| against the window.
    const shifted = d.getTime() + offset * DAY_MS;
    const drift = Math.abs(shifted - atMs);
    if (drift <= W && (e.data && e.data.verb === verb)) {
      daysWithHit.add(offset);
      hitsTotal += 1;
    }
  }
  const dwd = daysWithData.size;
  const dwh = daysWithHit.size;
  return {
    days_with_data: dwd,
    days_with_hit: dwh,
    ratio: dwd > 0 ? dwh / dwd : 0,
    hits_total: hitsTotal,
  };
}

// ─── domain factory ───────────────────────────────────────────────────────────

module.exports = function babyDomain(store) {
  const { entities, relations } = store;
  // 工厂里复用 events 域：这样 feed/diaper/sleep 都走同一条事件总线。
  // Re-use the events domain so all record paths share one event bus.
  const events = require('./events')(store);

  /**
   * Resolve a baby entity by id, returning the raw entity row (or throw).
   * `baby_id` is required when the store contains more than one baby.
   */
  async function resolveBaby(baby_id) {
    if (baby_id) {
      const b = await entities.get(baby_id);
      if (!b || b.type !== 'baby') throw new Error(`baby: no baby with id ${baby_id}`);
      return b;
    }
    const all = await entities.list({ type: 'baby', limit: 10 });
    if (all.length === 1) return all[0];
    if (!all.length) throw new Error('baby: no baby entity exists — create one with createBaby() first');
    throw new Error('baby: multiple babies exist — pass an explicit baby_id');
  }

  /** Bind an event to a baby via BOTH the for_baby edge AND data.baby_id. */
  async function bindToBaby(event, baby) {
    if (!event || !baby) return event;
    // 边：单值（每个 event 只属于一个宝宝），relations.replace 保证幂等。
    // The edge is single-valued; replace() guarantees idempotency on reruns.
    await relations.replace(event.id, FOR_BABY, baby.id, { family_id: event.family_id || null });
    // 同时把 baby_id 写进 data，保持与 legacy baby_log 的字段一致。
    // Also stamp data.baby_id so the legacy importer's shape is preserved.
    await entities.mergeData(event.id, { baby_id: baby.id });
    const fresh = await entities.get(event.id);
    return fresh || event;
  }

  return {
    FOR_BABY,
    VERBS,
    SCORING,
    PERSONAL_BASELINE,
    PATTERN,
    TREND,
    WAKE_WINDOW_TABLE,
    WAKE_WINDOW_DEFAULT,

    /** Create a baby（建一个宝宝档案）. */
    async createBaby({ name, birth_date, wake_window_min, family_id } = {}) {
      if (!name) throw new Error('baby.createBaby: `name` is required');
      return entities.create({
        type: 'baby',
        title: String(name),
        family_id: family_id || null,
        tags: ['baby'],
        occurred_at: birth_date || null,
        data: {
          birth_date: birth_date || null,
          wake_window_min: wake_window_min ?? null,
        },
      });
    },

    /** Record a feed event（喂奶）— amount in ml, milk_type defaults to 'formula'. */
    async feed({ baby_id, amount_ml, milk_type = 'formula', occurred_at, note, family_id } = {}) {
      const baby = await resolveBaby(baby_id);
      const ev = await events.record({
        verb: VERBS.FEED,
        occurred_at: occurred_at || new Date().toISOString(),
        note,
        family_id: family_id || baby.family_id || null,
        data: { milk_type, amount_ml: amount_ml ?? null, baby_id: baby.id },
      });
      return bindToBaby(ev, baby);
    },

    /** Record a diaper change（换尿布）. kind ∈ wet|dirty|mixed. */
    async diaper({ baby_id, kind = 'wet', occurred_at, note, family_id } = {}) {
      const baby = await resolveBaby(baby_id);
      const ev = await events.record({
        verb: VERBS.DIAPER,
        occurred_at: occurred_at || new Date().toISOString(),
        note,
        family_id: family_id || baby.family_id || null,
        data: { kind, baby_id: baby.id },
      });
      return bindToBaby(ev, baby);
    },

    /**
     * Record a sleep block（一觉）. occurred_at is the START time of the
     * block — matches the legacy baby-ops semantics (`time` = start).
     */
    async sleep({ baby_id, duration_min, occurred_at, note, family_id } = {}) {
      const baby = await resolveBaby(baby_id);
      const ev = await events.record({
        verb: VERBS.SLEEP,
        occurred_at: occurred_at || new Date().toISOString(),
        note,
        family_id: family_id || baby.family_id || null,
        data: { duration_min: duration_min ?? null, baby_id: baby.id },
      });
      return bindToBaby(ev, baby);
    },

    /**
     * Record a fussy episode（哼唧）— a pre-cry signal. No duration; it's
     * a moment, not a block. Fed into the trend layer of inferCryReason.
     */
    async fussy({ baby_id, occurred_at, note, family_id } = {}) {
      const baby = await resolveBaby(baby_id);
      const ev = await events.record({
        verb: VERBS.FUSSY,
        occurred_at: occurred_at || new Date().toISOString(),
        note,
        family_id: family_id || baby.family_id || null,
        data: { baby_id: baby.id },
      });
      return bindToBaby(ev, baby);
    },

    /**
     * Recent events belonging to a baby — newest first.
     * 既看 for_baby 边，也看 data->>'baby_id'，与历史数据兼容。
     * Matches events linked by the edge OR carrying data.baby_id (legacy).
     */
    async recentEvents({ baby_id, since, verbs } = {}) {
      if (!baby_id) throw new Error('baby.recentEvents: `baby_id` is required');
      const vals = [baby_id];
      let where = `e.type = 'life_event' AND e.archived = false AND (
                     EXISTS (SELECT 1 FROM relations r
                             WHERE r.subject_id = e.id
                               AND r.predicate = 'for_baby'
                               AND r.object_id = $1)
                     OR e.data->>'baby_id' = $1
                   )`;
      if (since) {
        const sinceIso = asDate(since) ? asDate(since).toISOString() : since;
        vals.push(sinceIso);
        where += ` AND COALESCE(e.occurred_at, e.created_at) >= $${vals.length}`;
      }
      if (Array.isArray(verbs) && verbs.length) {
        vals.push(verbs);
        where += ` AND e.data->>'verb' = ANY($${vals.length})`;
      }
      const r = await store.db.query(
        `SELECT e.* FROM entities e
         WHERE ${where}
         ORDER BY COALESCE(e.occurred_at, e.created_at) DESC`,
        vals
      );
      return r.rows.map(entities.row);
    },

    // exported helpers
    ageMonths,
    wakeWindowMin,

    /**
     * inferCryReason — 推断宝宝为什么哭。 THE feature.
     *
     * 纯派生函数（no entity writes）：拉过去 N 小时内的事件，按 SCORING
     * 公式给四个候选打分，归一化，把每一项的「证据」装在 signals[] 里返回。
     *
     * Returns `{ baby_id, at, age_months, candidates, facts }`. See repo
     * README / SPEC for the field meanings — each candidate also carries
     * `reasoning`, a one-line zh summary built from its top two signals.
     */
    async inferCryReason(opts = {}) {
      const {
        at = new Date(),
        lookback_hours = 24,
        personal_baseline_hours = PERSONAL_BASELINE.HOURS,
      } = opts || {};

      const baby = await resolveBaby(opts.baby_id);
      const atDate = asDate(at) || new Date();
      const since = new Date(atDate.getTime() - lookback_hours * 3600 * 1000);
      // 个人基线 + circadian 看更长的历史窗口（默认 7 天）。
      // Baseline & circadian layers pull a longer history (default 7 days).
      const baselineHours = Math.max(lookback_hours, Number(personal_baseline_hours) || PERSONAL_BASELINE.HOURS);
      const baselineSince = new Date(atDate.getTime() - baselineHours * 3600 * 1000);

      // 优先用调用方传入的覆盖值，再到宝宝档案 data 上找，最后回退查表。
      // Caller > baby.data > table — birth_date / wake_window_min override chain.
      const birth_date = opts.birth_date || (baby.data && baby.data.birth_date) || null;
      const overrideWake = opts.wake_window_min ?? (baby.data && baby.data.wake_window_min) ?? null;
      const tableWakeWindow = wakeWindowMin(birth_date, atDate);
      const baseWakeWindow = overrideWake != null && Number.isFinite(Number(overrideWake))
        ? Number(overrideWake)
        : tableWakeWindow;
      const age_months = ageMonths(birth_date, atDate);

      // v1 events (24h lookback) for the last-event signals;
      // baselineEvents (7d lookback) for baselines + circadian + fussy.
      const recent = await this.recentEvents({
        baby_id: baby.id,
        since,
        verbs: [VERBS.FEED, VERBS.DIAPER, VERBS.SLEEP],
      });
      const baselineEvents = await this.recentEvents({
        baby_id: baby.id,
        since: baselineSince,
        verbs: [VERBS.FEED, VERBS.DIAPER, VERBS.SLEEP, VERBS.FUSSY],
      });

      // ── 折出事实 / derive facts ────────────────────────────────────────
      const feeds = recent.filter((e) => e.data && e.data.verb === VERBS.FEED);
      const diapers = recent.filter((e) => e.data && e.data.verb === VERBS.DIAPER);
      const sleeps = recent.filter((e) => e.data && e.data.verb === VERBS.SLEEP);

      const lastFeed = feeds[0] || null;
      const lastDiaper = diapers[0] || null;
      const lastSleep = sleeps[0] || null;

      const minutesBetween = (a, b) => (a.getTime() - b.getTime()) / 60000;

      const minutes_since_last_feed = lastFeed && asDate(lastFeed.occurred_at)
        ? minutesBetween(atDate, asDate(lastFeed.occurred_at))
        : null;

      const minutes_since_last_diaper = lastDiaper && asDate(lastDiaper.occurred_at)
        ? minutesBetween(atDate, asDate(lastDiaper.occurred_at))
        : null;

      // 醒着多久 = at - (上次睡眠 start + duration)；没睡眠记录就用 lookback 内最早的一条事件作为「醒来时间」近似。
      // minutes_since_wake = at - (sleep.start + duration); fallback to earliest event in lookback.
      let minutes_since_wake = null;
      let last_sleep_duration_min = null;
      if (lastSleep && asDate(lastSleep.occurred_at)) {
        last_sleep_duration_min = Number(lastSleep.data && lastSleep.data.duration_min) || 0;
        const wokeAt = new Date(asDate(lastSleep.occurred_at).getTime() + last_sleep_duration_min * 60000);
        minutes_since_wake = minutesBetween(atDate, wokeAt);
      } else if (recent.length) {
        const earliest = recent[recent.length - 1];
        if (asDate(earliest.occurred_at)) {
          minutes_since_wake = minutesBetween(atDate, asDate(earliest.occurred_at));
        }
      }

      const last_feed_amount_ml = lastFeed && lastFeed.data && Number.isFinite(Number(lastFeed.data.amount_ml))
        ? Number(lastFeed.data.amount_ml)
        : null;
      const recent_feed_amounts = feeds
        .map((e) => Number(e.data && e.data.amount_ml))
        .filter((n) => Number.isFinite(n));
      const recent_avg_feed_amount_ml = recent_feed_amounts.length
        ? recent_feed_amounts.reduce((s, n) => s + n, 0) / recent_feed_amounts.length
        : null;

      const recent_sleep_durations = sleeps
        .map((e) => Number(e.data && e.data.duration_min))
        .filter((n) => Number.isFinite(n));
      const recent_avg_sleep_duration_min = recent_sleep_durations.length
        ? recent_sleep_durations.reduce((s, n) => s + n, 0) / recent_sleep_durations.length
        : null;

      // ── Layer A: 个人基线 / personal baselines ─────────────────────────
      // 从 7 天窗口里折出每个 verb 的中位数。样本不够就回退到群体表。
      // Compute medians per verb from the 7-day window. If samples < min,
      // we fall back to the age-table default for that reason.
      const baselineFeeds = baselineEvents.filter((e) => e.data && e.data.verb === VERBS.FEED);
      const baselineDiapers = baselineEvents.filter((e) => e.data && e.data.verb === VERBS.DIAPER);
      const baselineSleeps = baselineEvents.filter((e) => e.data && e.data.verb === VERBS.SLEEP);
      const baselineFussy = baselineEvents.filter((e) => e.data && e.data.verb === VERBS.FUSSY);

      const feedGaps = recentGapsMin(baselineFeeds, PERSONAL_BASELINE.MAX_FEED_SAMPLES);
      const diaperGaps = recentGapsMin(baselineDiapers, PERSONAL_BASELINE.MAX_DIAPER_SAMPLES);
      const wakeGaps = recentWakeWindowsMin(baselineSleeps, PERSONAL_BASELINE.MAX_WAKE_SAMPLES);

      const typicalFeedTable = (age_months != null && age_months < 6)
        ? SCORING.HUNGRY_INTERVAL_MIN_UNDER_6MO
        : SCORING.HUNGRY_INTERVAL_MIN_OVER_6MO;

      const feedBaseline = (feedGaps.length >= PERSONAL_BASELINE.MIN_FEED_SAMPLES)
        ? { value: Math.round(median(feedGaps)), sample: feedGaps.length, source: 'personal' }
        : { value: typicalFeedTable, sample: feedGaps.length, source: 'age_table' };

      const wakeBaseline = (wakeGaps.length >= PERSONAL_BASELINE.MIN_WAKE_SAMPLES)
        ? { value: Math.round(median(wakeGaps)), sample: wakeGaps.length, source: 'personal' }
        : { value: baseWakeWindow, sample: wakeGaps.length, source: 'age_table' };

      const diaperBaseline = (diaperGaps.length >= PERSONAL_BASELINE.MIN_DIAPER_SAMPLES)
        ? { value: Math.round(median(diaperGaps)), sample: diaperGaps.length, source: 'personal' }
        : { value: SCORING.WET_INTERVAL_MIN, sample: diaperGaps.length, source: 'age_table' };

      // The thresholds the SCORING math actually uses (personal overrides table).
      const typicalFeed = feedBaseline.value;
      const wakeWindow = wakeBaseline.value;
      const typicalDiaper = diaperBaseline.value;

      const facts = {
        minutes_since_last_feed,
        minutes_since_last_diaper,
        minutes_since_wake,
        last_feed_amount_ml,
        recent_avg_feed_amount_ml,
        last_sleep_duration_min,
        recent_avg_sleep_duration_min,
        baselines: {
          feed_interval: feedBaseline,
          wake_window: wakeBaseline,
          diaper_interval: diaperBaseline,
        },
      };

      // ── Layer B: 时间-of-day 圈昼夜节律 / circadian pattern ─────────────
      // For each verb, count days_with_hit / days_with_data over the last 7 days.
      const patternFeed = timeOfDayHits(baselineEvents, atDate, VERBS.FEED);
      const patternSleep = timeOfDayHits(baselineEvents, atDate, VERBS.SLEEP);
      const patternDiaper = timeOfDayHits(baselineEvents, atDate, VERBS.DIAPER);

      function patternSignal(p, verbZh) {
        // Returns { positive } or { negative } or null. Caller maps to candidates.
        const dwd = p.days_with_data;
        const dwh = p.days_with_hit;
        if (dwd < PATTERN.MIN_DAYS) return null;
        const ratio = p.ratio;
        if (ratio >= PATTERN.HIT_RATIO) {
          return {
            kind: 'time_of_day_pattern',
            polarity: 'positive',
            text: `过去 ${dwd} 天此时 ${dwh}/${dwd} 在${verbZh}`,
            value: dwh,
            benchmark: `${PATTERN.DAYS} 天样本`,
            weight: PATTERN.POSITIVE_WEIGHT,
          };
        }
        return null;
      }
      function patternNegativeSignal(p, verbZh) {
        // Used to penalize OTHER candidates when this verb dominates this hour.
        if (p.days_with_data < PATTERN.MIN_DAYS) return null;
        if (p.ratio < PATTERN.HIT_RATIO) return null;
        return {
          kind: 'time_of_day_pattern',
          polarity: 'negative',
          text: `过去 ${p.days_with_data} 天此时通常在${verbZh}（不太像此原因）`,
          value: p.days_with_hit,
          benchmark: `${PATTERN.DAYS} 天样本`,
          weight: PATTERN.NEGATIVE_WEIGHT,
        };
      }

      // ── Layer C: trend / pre-cry build-up ──────────────────────────────
      // Recent fussy episodes inside FUSSY_LOOKBACK_MIN.
      const fussyCutoff = new Date(atDate.getTime() - TREND.FUSSY_LOOKBACK_MIN * 60000);
      const recentFussy = baselineFussy.filter((e) => {
        const d = asDate(e.occurred_at);
        return d && d.getTime() >= fussyCutoff.getTime() && d.getTime() <= atDate.getTime();
      });

      // Last 3 feeds monotonically decreasing amount_ml? feeds[] is DESC.
      let feedAmountsDecreasing = false;
      const last3FeedAmounts = feeds.slice(0, 3)
        .map((e) => Number(e.data && e.data.amount_ml))
        .filter((n) => Number.isFinite(n));
      if (last3FeedAmounts.length === 3) {
        // DESC order: [newest, mid, oldest]. Monotonically decreasing IN TIME
        // means newest < mid < oldest.
        feedAmountsDecreasing = last3FeedAmounts[0] < last3FeedAmounts[1]
                              && last3FeedAmounts[1] < last3FeedAmounts[2];
      }

      // ── 四个候选评分 / score each candidate ────────────────────────────
      const candidates = [];

      // HUNGRY
      {
        const typical = typicalFeed; // personal-or-table
        const signals = [];
        let base = 0;
        if (minutes_since_last_feed != null) {
          const ratio = minutes_since_last_feed / typical;
          base = clamp(ratio - SCORING.BASE_HALF_OFFSET, 0, 1);
          const benchmark = feedBaseline.source === 'personal'
            ? `个人均值 ${typical} 分钟（${feedBaseline.sample} 次样本）`
            : `该月龄典型喂奶间隔约 ${typical} 分钟（群体表）`;
          signals.push({
            kind: 'time_since_last',
            text: `距上次喂奶 ${Math.round(minutes_since_last_feed)} 分钟`,
            value: Math.round(minutes_since_last_feed),
            unit: 'min',
            benchmark,
            weight: round3(base),
          });
        } else {
          signals.push({
            kind: 'no_data',
            text: '最近无喂奶记录',
            value: null,
            benchmark: feedBaseline.source === 'personal'
              ? `个人均值 ${typical} 分钟`
              : `典型喂奶间隔约 ${typical} 分钟`,
            weight: 0,
          });
        }
        // 个人基线说明 / personal-baseline explanation signal (weight 0).
        if (feedBaseline.source === 'personal') {
          signals.push({
            kind: 'personal_baseline',
            text: `个人基线：典型喂奶间隔 ${typical} 分钟（最近 ${Math.round(baselineHours / 24)} 天 ${feedBaseline.sample} 次）`,
            value: typical,
            benchmark: `群体表 ${typicalFeedTable}`,
            weight: 0,
          });
        }
        let bonus = 0;
        if (last_feed_amount_ml != null && recent_avg_feed_amount_ml != null
            && recent_avg_feed_amount_ml > 0
            && last_feed_amount_ml < SCORING.HUNGRY_SMALL_LAST_FEED_THRESHOLD * recent_avg_feed_amount_ml) {
          bonus = SCORING.HUNGRY_SMALL_LAST_FEED_BONUS;
          signals.push({
            kind: 'feed_volume_below_avg',
            text: `上次喂 ${last_feed_amount_ml}ml（最近均值 ${Math.round(recent_avg_feed_amount_ml)}ml）`,
            value: last_feed_amount_ml,
            unit: 'ml',
            benchmark: `最近均值 ${Math.round(recent_avg_feed_amount_ml)}ml`,
            weight: round3(bonus),
          });
        }
        // Layer B: circadian — hits THIS verb (positive); hits a DIFFERENT
        // dominating verb (negative).
        const posFeed = patternSignal(patternFeed, '吃奶');
        if (posFeed) signals.push(posFeed);
        const negSleepOnHungry = patternNegativeSignal(patternSleep, '睡觉');
        if (negSleepOnHungry) {
          signals.push({
            ...negSleepOnHungry,
            text: `过去 ${patternSleep.days_with_data} 天此时通常在睡（不太像饿）`,
          });
        }
        // Layer C: 喂量单调下降 → 减分 / feeds shrinking → not real hunger.
        if (feedAmountsDecreasing) {
          signals.push({
            kind: 'feed_amount_trend_down',
            polarity: 'negative',
            text: `最近 3 次喂量在下降（可能厌奶，不是真饿）`,
            value: last3FeedAmounts.join('→'),
            benchmark: '近 3 次单调递减',
            weight: TREND.FEED_DECREASE_WEIGHT,
          });
        }
        candidates.push({
          reason: 'hungry', label: '饿了', icon: '🍼',
          _base: clamp(base + bonus, 0, 1),
          signals,
        });
      }

      // SLEEPY
      {
        const signals = [];
        let base = 0;
        if (minutes_since_wake != null && wakeWindow > 0) {
          const ratio = minutes_since_wake / wakeWindow;
          base = clamp(ratio - SCORING.BASE_HALF_OFFSET, 0, 1);
          const benchmark = wakeBaseline.source === 'personal'
            ? `个人均值 wake window ${wakeWindow} 分钟（${wakeBaseline.sample} 个样本）`
            : `该月龄典型 wake window 约 ${wakeWindow} 分钟（群体表）`;
          signals.push({
            kind: 'time_since_last',
            text: `已醒 ${Math.round(minutes_since_wake)} 分钟`,
            value: Math.round(minutes_since_wake),
            unit: 'min',
            benchmark,
            weight: round3(base),
          });
        } else {
          signals.push({
            kind: 'no_data',
            text: '最近无睡眠记录',
            value: null,
            benchmark: wakeBaseline.source === 'personal'
              ? `个人均值 wake window ${wakeWindow} 分钟`
              : `典型 wake window 约 ${wakeWindow} 分钟`,
            weight: 0,
          });
        }
        // 个人基线说明 / personal-baseline explanation signal.
        if (wakeBaseline.source === 'personal') {
          signals.push({
            kind: 'personal_baseline',
            text: `个人基线：典型 wake window ${wakeWindow} 分钟（最近 ${Math.round(baselineHours / 24)} 天 ${wakeBaseline.sample} 段）`,
            value: wakeWindow,
            benchmark: `群体表 ${tableWakeWindow}`,
            weight: 0,
          });
        }
        let bonus = 0;
        if (last_sleep_duration_min != null && last_sleep_duration_min > 0
            && last_sleep_duration_min < SCORING.SLEEPY_SHORT_NAP_MAX_MIN) {
          bonus = SCORING.SLEEPY_SHORT_NAP_BONUS;
          signals.push({
            kind: 'short_last_nap',
            text: `上一觉只睡了 ${last_sleep_duration_min} 分钟`,
            value: last_sleep_duration_min,
            unit: 'min',
            benchmark: `短于 ${SCORING.SLEEPY_SHORT_NAP_MAX_MIN} 分钟视为没睡好`,
            weight: round3(bonus),
          });
        }
        // Layer B: circadian (positive on sleep; negative on hungry-time).
        const posSleep = patternSignal(patternSleep, '睡觉');
        if (posSleep) signals.push(posSleep);
        const negFeedOnSleepy = patternNegativeSignal(patternFeed, '吃奶');
        if (negFeedOnSleepy) {
          signals.push({
            ...negFeedOnSleepy,
            text: `过去 ${patternFeed.days_with_data} 天此时通常在吃奶（不太像困）`,
          });
        }
        // Layer C: fussy 积聚 → 困了。
        if (recentFussy.length >= TREND.FUSSY_THRESHOLD) {
          signals.push({
            kind: 'fussy_buildup',
            text: `最近 1 小时有 ${recentFussy.length} 次哼唧`,
            value: recentFussy.length,
            benchmark: `≥ ${TREND.FUSSY_THRESHOLD} 次视为积聚`,
            weight: TREND.FUSSY_WEIGHT,
          });
        }
        // Layer C: 已超 wake window 1.5x。
        if (minutes_since_wake != null && wakeWindow > 0
            && minutes_since_wake > TREND.OVERTIME_MULTIPLIER * wakeWindow) {
          signals.push({
            kind: 'wake_window_overtime',
            text: `已超 wake-window ${TREND.OVERTIME_MULTIPLIER} 倍（${Math.round(minutes_since_wake)} 分钟 vs ${wakeWindow} 分钟）`,
            value: Math.round(minutes_since_wake),
            benchmark: `${TREND.OVERTIME_MULTIPLIER}× ${wakeWindow} = ${Math.round(TREND.OVERTIME_MULTIPLIER * wakeWindow)} 分钟`,
            weight: TREND.OVERTIME_WEIGHT,
          });
        }
        candidates.push({
          reason: 'sleepy', label: '困了', icon: '😴',
          _base: clamp(base + bonus, 0, 1),
          signals,
        });
      }

      // WET
      {
        const signals = [];
        let base = 0;
        let suppressedByDirty = false;
        if (minutes_since_last_diaper != null) {
          const ratio = minutes_since_last_diaper / typicalDiaper;
          base = clamp(ratio - SCORING.BASE_HALF_OFFSET, 0, 1);
          const benchmark = diaperBaseline.source === 'personal'
            ? `个人均值 ${typicalDiaper} 分钟（${diaperBaseline.sample} 次样本）`
            : `典型换尿布间隔约 ${typicalDiaper} 分钟（群体表）`;
          signals.push({
            kind: 'time_since_last',
            text: `距上次换尿布 ${Math.round(minutes_since_last_diaper)} 分钟`,
            value: Math.round(minutes_since_last_diaper),
            unit: 'min',
            benchmark,
            weight: round3(base),
          });
          // 刚拉过 dirty → 抑制 wet 分。Just changed a dirty diaper -> near-zero.
          const lastKind = lastDiaper && lastDiaper.data && lastDiaper.data.kind;
          if (lastKind === 'dirty' && minutes_since_last_diaper < SCORING.WET_RECENT_DIRTY_SUPPRESS_MIN) {
            base = 0;
            suppressedByDirty = true;
            signals.push({
              kind: 'recently_changed_dirty',
              text: `${Math.round(minutes_since_last_diaper)} 分钟前刚换过 dirty 尿布`,
              value: Math.round(minutes_since_last_diaper),
              unit: 'min',
              benchmark: `${SCORING.WET_RECENT_DIRTY_SUPPRESS_MIN} 分钟内刚换过则不太可能再湿`,
              weight: 0,
            });
          }
        } else {
          signals.push({
            kind: 'no_data',
            text: '最近无换尿布记录',
            value: null,
            benchmark: diaperBaseline.source === 'personal'
              ? `个人均值 ${typicalDiaper} 分钟`
              : `典型换尿布间隔约 ${typicalDiaper} 分钟`,
            weight: 0,
          });
        }
        // 个人基线说明 / personal-baseline explanation signal.
        if (diaperBaseline.source === 'personal') {
          signals.push({
            kind: 'personal_baseline',
            text: `个人基线：典型换尿布间隔 ${typicalDiaper} 分钟（最近 ${Math.round(baselineHours / 24)} 天 ${diaperBaseline.sample} 次）`,
            value: typicalDiaper,
            benchmark: `群体表 ${SCORING.WET_INTERVAL_MIN}`,
            weight: 0,
          });
        }
        // Layer B: circadian — only when WET isn't already suppressed.
        if (!suppressedByDirty) {
          const posDiaper = patternSignal(patternDiaper, '换尿布');
          if (posDiaper) signals.push(posDiaper);
        }
        candidates.push({
          reason: 'wet', label: '要换尿布', icon: '💩',
          _base: clamp(base, 0, 1),
          // Suppression of WET overrides any layer B/C bonus — once we know
          // the diaper was just changed, no pattern bonus should resurrect it.
          _no_pattern_bonus: suppressedByDirty,
          signals,
        });
      }

      // PLAY — 「想玩」是负空间：其他三项越低、清醒越久，越像想玩。
      // PLAY is the negative-space candidate: high only when nothing else fits.
      {
        const others = candidates.map((c) => c._base);
        const maxOther = others.length ? Math.max(...others) : 0;
        const awakeRatio = (minutes_since_wake != null && wakeWindow > 0)
          ? Math.min(1, minutes_since_wake / wakeWindow)
          : 0;
        const base = Math.max(0, 1 - maxOther) * awakeRatio;
        const signals = [{
          kind: 'negative_space',
          text: `其他原因都不强（最高 ${round3(maxOther)}），且已清醒一段时间`,
          value: round3(maxOther),
          benchmark: '当 hungry/sleepy/wet 都不显著时，剩下的就是想互动',
          weight: round3(base),
        }];
        if (minutes_since_wake != null) {
          signals.push({
            kind: 'awake_window',
            text: `已醒 ${Math.round(minutes_since_wake)} 分钟（wake window ${wakeWindow}）`,
            value: Math.round(minutes_since_wake),
            unit: 'min',
            benchmark: `${wakeWindow} 分钟`,
            weight: round3(awakeRatio),
          });
        }
        candidates.push({
          reason: 'play', label: '想玩', icon: '🎲',
          _base: clamp(base, 0, 1),
          signals,
        });
      }

      // ── 把 Layer B/C 的 pattern_bonus 叠加到 base 上 / fold pattern weights.
      // pattern_bonus = Σ weight of all NON-base signals (kind ∉ time_since_last,
      //   short_last_nap, feed_volume_below_avg, recently_changed_dirty,
      //   negative_space, awake_window, no_data, personal_baseline).
      // personal_baseline is weight=0 anyway; we skip the v1 base signals so we
      // don't double-count their already-applied weight.
      const V1_BASE_KINDS = new Set([
        'time_since_last',
        'short_last_nap',
        'feed_volume_below_avg',
        'recently_changed_dirty',
        'negative_space',
        'awake_window',
        'no_data',
        'personal_baseline',
      ]);
      for (const c of candidates) {
        if (c._no_pattern_bonus) {
          c._raw = c._base;
        } else {
          const bonus = c.signals
            .filter((s) => !V1_BASE_KINDS.has(s.kind))
            .reduce((s, sig) => s + (Number(sig.weight) || 0), 0);
          c._raw = Math.max(0, c._base + bonus);
        }
      }

      // ── softmax-light: divide each raw by the sum so candidates sum to ~1 ──
      const total = candidates.reduce((s, c) => s + c._raw, 0);
      for (const c of candidates) {
        c.score = total > 0 ? round3(c._raw / total) : 0;
        delete c._raw;
        delete c._base;
        delete c._no_pattern_bonus;
        // reasoning = 按 |weight| 取顶部三条的 text 拼起来，含负向信号。
        // top-3 by |weight| so meaningful negative signals can earn a slot.
        const top3 = c.signals.slice().sort((a, b) =>
          Math.abs(b.weight || 0) - Math.abs(a.weight || 0)
        ).slice(0, 3);
        c.reasoning = top3.map((s) => s.text).filter(Boolean).join('；') || '无明显证据';
      }
      candidates.sort((a, b) => b.score - a.score);

      return {
        baby_id: baby.id,
        at: atDate.toISOString(),
        age_months: age_months == null ? null : round3(age_months),
        candidates,
        facts,
      };
    },
  };
};

// ─── exported helpers (also reachable off the factory) ───────────────────────
module.exports.ageMonths = ageMonths;
module.exports.wakeWindowMin = wakeWindowMin;

// ─── entity type registration ────────────────────────────────────────────────
module.exports.types = [
  { type: 'baby', domain: 'baby', label: '宝宝', icon: '👶',
    description: '宝宝档案与日志推断',
    schema: { fields: {
      name: 'text',
      birth_date: 'date',
      wake_window_min: 'number',
    } } },
];

// ─── manifest: CLI commands ──────────────────────────────────────────────────
module.exports.commands = (d, { num }) => ({
  'baby-add': {
    desc: '建一个宝宝档案', usage: 'baby-add <name> [--birth DATE] [--wake-window MIN] [--family ID]',
    run: ({ positional, flags }) => d.createBaby({
      name: positional.join(' '),
      birth_date: flags.birth,
      wake_window_min: num(flags['wake-window']),
      family_id: flags.family,
    }),
  },
  feed: {
    desc: '记一次喂奶', usage: 'feed <baby_id> --amount-ml N [--type T] [--at ISO] [--note S]',
    run: ({ positional, flags }) => d.feed({
      baby_id: positional[0],
      amount_ml: num(flags['amount-ml']),
      milk_type: flags.type || undefined,
      occurred_at: flags.at,
      note: flags.note,
    }),
  },
  diaper: {
    desc: '记一次换尿布', usage: 'diaper <baby_id> [--kind wet|dirty|mixed] [--at ISO] [--note S]',
    run: ({ positional, flags }) => d.diaper({
      baby_id: positional[0],
      kind: flags.kind || 'wet',
      occurred_at: flags.at,
      note: flags.note,
    }),
  },
  sleep: {
    desc: '记一觉', usage: 'sleep <baby_id> --minutes N [--at ISO] [--note S]',
    run: ({ positional, flags }) => d.sleep({
      baby_id: positional[0],
      duration_min: num(flags.minutes),
      occurred_at: flags.at,
      note: flags.note,
    }),
  },
  cry: {
    desc: '推断「为什么哭」（透明评分）', usage: 'cry <baby_id> [--at ISO] [--lookback-hours N]',
    run: ({ positional, flags }) => d.inferCryReason({
      baby_id: positional[0],
      at: flags.at,
      lookback_hours: num(flags['lookback-hours']),
    }),
  },
});

// ─── manifest: capture-router intents (SPEC-plugins.md §3.3) ─────────────────
module.exports.intents = (store) => {
  const { z } = require('zod');
  const baby = module.exports(store);

  // baby_id 解析策略：调用方给了就用；否则取库里唯一的一只宝宝。
  // resolveOne — single-baby happy path; ambiguous case bubbles to router.
  async function resolveOneBaby(explicit) {
    if (explicit) return explicit;
    const all = await store.entities.list({ type: 'baby', limit: 10 });
    if (all.length === 1) return all[0].id;
    if (!all.length) throw new Error('baby.intent: no baby exists — create one first');
    throw new Error('baby.intent: multiple babies — specify args.baby_id');
  }

  return [
    {
      name: 'baby.feed',
      description:
        'Record a baby feeding (记一次喂奶). Extract amount in ml; ' +
        'optional milk_type (formula/ready_to_feed/breast).',
      confirm: 'low',
      schema: z.object({
        baby_id: z.string().optional().describe('baby entity id / 宝宝 id'),
        amount_ml: z.number().int().describe('feed amount in ml / 奶量(ml)'),
        milk_type: z.string().optional().describe('formula / ready_to_feed / breast'),
        note: z.string().optional(),
      }),
      rules(c) {
        const m = (c.text || '').match(/(?:喂(?:了)?|fed)\s*(\d+)\s*(ml|毫升)?/i);
        if (!m) return null;
        return { args: { amount_ml: Number(m[1]) } };
      },
      async run(args) {
        const baby_id = await resolveOneBaby(args.baby_id);
        return baby.feed({
          baby_id, amount_ml: args.amount_ml,
          milk_type: args.milk_type, note: args.note,
        });
      },
    },
    {
      name: 'baby.diaper',
      description:
        'Record a diaper change (记一次换尿布). kind ∈ wet|dirty|mixed.',
      confirm: 'low',
      schema: z.object({
        baby_id: z.string().optional(),
        kind: z.enum(['wet', 'dirty', 'mixed']).optional(),
        note: z.string().optional(),
      }),
      rules(c) {
        const m = (c.text || '').match(/(换尿布|拉了|尿了|diaper)(?:\s*(wet|dirty|湿|脏|大便))?/i);
        if (!m) return null;
        const raw = (m[2] || '').toLowerCase();
        const kind = raw === 'dirty' || raw === '脏' || raw === '大便' ? 'dirty'
                   : raw === 'wet' || raw === '湿' ? 'wet'
                   : undefined;
        return { args: kind ? { kind } : {} };
      },
      async run(args) {
        const baby_id = await resolveOneBaby(args.baby_id);
        return baby.diaper({ baby_id, kind: args.kind || 'wet', note: args.note });
      },
    },
    {
      name: 'baby.sleep',
      description:
        'Record a sleep block (记一觉). duration in minutes.',
      confirm: 'low',
      schema: z.object({
        baby_id: z.string().optional(),
        duration_min: z.number().int(),
        note: z.string().optional(),
      }),
      rules(c) {
        const m = (c.text || '').match(/(?:睡(?:了)?|nap|slept)\s*(\d+)\s*(min|分钟)?/i);
        if (!m) return null;
        return { args: { duration_min: Number(m[1]) } };
      },
      async run(args) {
        const baby_id = await resolveOneBaby(args.baby_id);
        return baby.sleep({ baby_id, duration_min: args.duration_min, note: args.note });
      },
    },
    {
      name: 'baby.fussy',
      description:
        'Record a fussy/pre-cry episode (记一次哼唧). Used by inferCryReason ' +
        'trend layer — multiple fussy events in the last hour signal sleepy.',
      confirm: 'never',
      schema: z.object({
        baby_id: z.string().optional(),
        note: z.string().optional(),
      }),
      rules(c) {
        const m = (c.text || '').match(/(哼唧|fussy)/i);
        if (!m) return null;
        return { args: {} };
      },
      async run(args) {
        const baby_id = await resolveOneBaby(args.baby_id);
        return baby.fussy({ baby_id, note: args.note });
      },
    },
  ];
};
