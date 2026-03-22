'use strict';
const { PATHS, readJSON, writeJSON, today } = require('./data');

function readBabyLog() {
  return readJSON(PATHS.BABY_LOG, { version: "1.0", events: [], baby: null });
}

function nowISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function listBabyEvents({ type, date, limit = 50 } = {}) {
  const log = readBabyLog();
  let events = log.events;
  if (type) events = events.filter(e => e.type === type);
  if (date) events = events.filter(e => e.time.startsWith(date));
  events = events.slice().reverse().slice(0, parseInt(limit));
  return { baby: log.baby || null, events, total: log.events.length };
}

function babyStats() {
  const log = readBabyLog();
  const todayStr = today();
  const todayEvents = log.events.filter(e => e.time.startsWith(todayStr));
  const feedings = todayEvents.filter(e => e.type === "feeding_bottle");
  const diapers = todayEvents.filter(e => e.type === "diaper");
  const sleeps = todayEvents.filter(e => e.type === "sleep");
  const totalMl = feedings.reduce((s, e) => s + (e.data?.amount_ml || 0), 0);
  const diaperWet = diapers.filter(e => e.data?.status === "wet" || e.data?.status === "wet_and_dirty").length;
  const diaperDirty = diapers.filter(e => e.data?.status === "dirty" || e.data?.status === "wet_and_dirty").length;
  const totalSleepMin = sleeps.reduce((s, e) => s + (e.data?.duration_min || 0), 0);
  const latestGrowth = [...log.events].reverse().find(e => e.type === "growth");
  return {
    baby: log.baby,
    today: {
      feeding_count: feedings.length,
      feeding_total_ml: totalMl,
      diaper_count: diapers.length,
      diaper_wet: diaperWet,
      diaper_dirty: diaperDirty,
      sleep_count: sleeps.length,
      sleep_total_min: totalSleepMin,
    },
    latest_growth: latestGrowth?.data || null,
    total_events: log.events.length,
  };
}

function logBabyEvent({ type, time, data, baby_id }) {
  const validTypes = ["feeding_bottle", "feeding_nursing", "feeding_solid", "diaper", "sleep", "growth", "milestone", "bath", "medicine", "doctor_visit"];
  if (!validTypes.includes(type)) throw new Error(`不支持的事件类型: ${type}`);
  const eventTime = time || nowISO();
  const id = `manual_${type}_${Date.now()}`;
  const event = { id, type, time: eventTime, data: data || {} };
  if (baby_id) event.baby_id = baby_id;
  const log = readBabyLog();
  log.events.push(event);
  log.events.sort((a, b) => a.time.localeCompare(b.time));
  writeJSON(PATHS.BABY_LOG, log);
  return event;
}

function deleteBabyEvent(id) {
  const log = readBabyLog();
  const idx = log.events.findIndex(e => e.id === id);
  if (idx === -1) throw new Error("事件不存在");
  log.events.splice(idx, 1);
  writeJSON(PATHS.BABY_LOG, log);
  return { success: true };
}

module.exports = {
  readBabyLog,
  listBabyEvents,
  babyStats,
  logBabyEvent,
  deleteBabyEvent,
};
