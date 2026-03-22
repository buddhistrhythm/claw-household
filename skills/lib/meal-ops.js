'use strict';
const { PATHS, readJSON, writeJSON, today } = require('./data');

function readMealDiary() {
  return readJSON(PATHS.MEAL_DIARY, { version: "1.0", ingredients: [], dishes: [], meals: [] });
}

function writeMealDiary(d) {
  writeJSON(PATHS.MEAL_DIARY, d);
}

function genMealId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeIngredientToken(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

function ingredientLabelFromLine(line) {
  let s = String(line).trim();
  if (!s) return "";
  s = s
    .replace(/^[\d０-９]+(\.[\d０-９]+)?\s*[个只颗根条盒瓶袋包克g斤两毫升升Lm]+\s*/i, "")
    .trim();
  if (!s) {
    const m = String(line).match(/[\u4e00-\u9fffA-Za-z]+/g);
    return m ? m.join("") : String(line).trim();
  }
  return s.split(/[、,，]/)[0].trim() || s;
}

function findMatchingInventoryItem(ingName, invItems) {
  const n = normalizeIngredientToken(ingName);
  if (!n) return null;
  const inStock = invItems.filter((i) => i.status === "in_stock" && Number(i.quantity) > 0);
  let hit = inStock.find((i) => normalizeIngredientToken(i.name) === n);
  if (hit) return hit;
  const sorted = [...inStock].sort((a, b) => String(b.name).length - String(a.name).length);
  hit = sorted.find((i) => {
    const nm = normalizeIngredientToken(i.name);
    return nm.includes(n) || n.includes(nm);
  });
  return hit || null;
}

function addIngredient(name) {
  if (!name || !String(name).trim()) throw new Error("名称必填");
  const d = readMealDiary();
  const ing = { id: genMealId("ing"), name: String(name).trim().slice(0, 80), unit_default: null, tags: [] };
  d.ingredients.push(ing);
  writeMealDiary(d);
  return ing;
}

function addDish({ name, ingredient_refs, steps, favorite, notes }) {
  if (!name || !String(name).trim()) throw new Error("菜名必填");
  const d = readMealDiary();
  const dish = {
    id: genMealId("dish"),
    name: String(name).trim().slice(0, 120),
    ingredient_refs: Array.isArray(ingredient_refs) ? ingredient_refs : [],
    steps: steps != null ? String(steps).slice(0, 8000) : "",
    favorite: !!favorite,
    notes: notes != null ? String(notes).slice(0, 2000) : "",
  };
  d.dishes.push(dish);
  writeMealDiary(d);
  return dish;
}

function patchDish(id, patch) {
  const d = readMealDiary();
  const idx = d.dishes.findIndex((x) => x.id === id);
  if (idx === -1) throw new Error("菜谱不存在");
  Object.assign(d.dishes[idx], patch);
  writeMealDiary(d);
  return d.dishes[idx];
}

function deleteDish(id) {
  const d = readMealDiary();
  const idx = d.dishes.findIndex((x) => x.id === id);
  if (idx === -1) throw new Error("菜谱不存在");
  d.dishes.splice(idx, 1);
  writeMealDiary(d);
  return { success: true };
}

function addMeal({ date, slot, dish_ids, notes, liked }) {
  if (!date || !String(date).trim()) throw new Error("日期必填");
  const d = readMealDiary();
  const meal = {
    id: genMealId("meal"),
    date: String(date).trim().slice(0, 10),
    slot: slot || "lunch",
    dish_ids: Array.isArray(dish_ids) ? dish_ids : [],
    notes: notes != null ? String(notes).slice(0, 2000) : "",
    liked: liked !== false,
  };
  d.meals.push(meal);
  writeMealDiary(d);
  return meal;
}

function deleteMeal(id) {
  const d = readMealDiary();
  const idx = d.meals.findIndex((x) => x.id === id);
  if (idx === -1) throw new Error("记录不存在");
  d.meals.splice(idx, 1);
  writeMealDiary(d);
  return { success: true };
}

function cookingRecommendations() {
  const inv = readJSON(PATHS.INVENTORY, { items: [] });
  const invItems = Array.isArray(inv.items) ? inv.items : [];
  const d = readMealDiary();
  const dishes = d.dishes || [];
  const meals = d.meals || [];
  const counts = {};
  for (const m of meals) {
    for (const did of m.dish_ids || []) {
      counts[did] = (counts[did] || 0) + 1;
    }
  }
  const topPairs = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const top_dishes = topPairs.map(([id, count]) => {
    const dish = dishes.find((x) => x.id === id);
    return { dish_id: id, name: dish ? dish.name : id, count };
  });
  const dishPool = new Map();
  for (const [id, count] of topPairs) {
    const dish = dishes.find((x) => x.id === id);
    if (dish) dishPool.set(id, { dish, count });
  }
  for (const dish of dishes) {
    if (dish.favorite && !dishPool.has(dish.id)) {
      dishPool.set(dish.id, { dish, count: counts[dish.id] || 0 });
    }
  }
  const gap_one = [];
  for (const { dish, count } of dishPool.values()) {
    const refs = dish.ingredient_refs || [];
    const lines = refs
      .map((r) => (r && typeof r === "object" && r.text != null ? r.text : r))
      .filter((x) => x != null && String(x).trim());
    if (lines.length === 0) continue;
    const missing = [];
    for (const line of lines) {
      const label = ingredientLabelFromLine(String(line));
      if (!label) continue;
      if (!findMatchingInventoryItem(label, invItems)) missing.push(label);
    }
    if (missing.length === 1) {
      gap_one.push({ dish_id: dish.id, name: dish.name, eat_count: count, missing: missing[0] });
    }
  }
  gap_one.sort((a, b) => b.eat_count - a.eat_count);
  return { top_dishes, gap_one };
}

function addRestockFromCooking(ingredient_name) {
  if (!ingredient_name || !String(ingredient_name).trim()) throw new Error("名称必填");
  const name = String(ingredient_name).trim().slice(0, 80);
  const inv = readJSON(PATHS.INVENTORY, { items: [] });
  if (!Array.isArray(inv.items)) inv.items = [];
  const hit = findMatchingInventoryItem(name, inv.items);
  if (hit) {
    const idx = inv.items.findIndex((i) => i.id === hit.id);
    inv.items[idx] = { ...inv.items[idx], restock_needed: true };
    inv.last_updated = today();
    writeJSON(PATHS.INVENTORY, inv);
    return { mode: "inventory", item_id: hit.id };
  }
  const prefs = readJSON(PATHS.PREFERENCES);
  const shop = prefs.shopping || {};
  const pending = Array.isArray(shop.pending_ingredients) ? [...shop.pending_ingredients] : [];
  if (!pending.some((p) => p && p.name === name)) {
    pending.push({ name, at: new Date().toISOString() });
  }
  prefs.shopping = { ...shop, pending_ingredients: pending };
  writeJSON(PATHS.PREFERENCES, prefs);
  return { mode: "pending" };
}

function deletePendingIngredient(name) {
  if (!name) throw new Error("name 必填");
  const prefs = readJSON(PATHS.PREFERENCES);
  const shop = prefs.shopping || {};
  const pending = Array.isArray(shop.pending_ingredients) ? shop.pending_ingredients : [];
  const next = pending.filter((p) => !p || p.name !== name);
  prefs.shopping = { ...shop, pending_ingredients: next };
  writeJSON(PATHS.PREFERENCES, prefs);
  return { success: true };
}

module.exports = {
  readMealDiary,
  writeMealDiary,
  normalizeIngredientToken,
  ingredientLabelFromLine,
  findMatchingInventoryItem,
  addIngredient,
  addDish,
  patchDish,
  deleteDish,
  addMeal,
  deleteMeal,
  cookingRecommendations,
  addRestockFromCooking,
  deletePendingIngredient,
};
