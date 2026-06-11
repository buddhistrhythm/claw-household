'use strict';

/**
 * storage.js — "东西归置": where things are.
 *
 * Locations and items are both entities; placement is a first-class relation:
 *   item -[stored_in]-> location          (single-valued: an item is in one place)
 *   location -[inside]-> parent_location   (nesting: drawer inside cabinet)
 */

const STORED_IN = 'stored_in';
const INSIDE = 'inside';

module.exports = function storageDomain(store) {
  const { entities, relations } = store;

  return {
    async createLocation({ name, kind, note, parentId, family_id } = {}) {
      const loc = await entities.create({
        type: 'storage_location', title: name, family_id,
        data: { kind: kind || null, note: note || null },
        tags: ['storage'],
      });
      if (parentId) await relations.replace(loc.id, INSIDE, parentId, { family_id });
      return loc;
    },

    async createItem({ name, quantity, unit, category, locationId, family_id } = {}) {
      const item = await entities.create({
        type: 'item', title: name, family_id,
        data: { quantity: quantity ?? 1, unit: unit || null, category: category || null },
        tags: ['item'],
      });
      if (locationId) await relations.replace(item.id, STORED_IN, locationId, { family_id });
      return item;
    },

    /** Move an item to a location (replaces any prior placement). */
    async place(itemId, locationId, opts = {}) {
      return relations.replace(itemId, STORED_IN, locationId, opts);
    },

    /** The location chain for an item: [immediate, parent, grandparent, …]. */
    async whereIs(itemId) {
      const placed = await relations.from(itemId, STORED_IN);
      if (!placed.length) return { item_id: itemId, located: false, chain: [] };
      const chain = [];
      let current = placed[0].object_id;
      const seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        const loc = await entities.get(current);
        if (!loc) break;
        chain.push({ id: loc.id, name: loc.title, kind: loc.data.kind || null });
        const up = await relations.from(loc.id, INSIDE);
        current = up.length ? up[0].object_id : null;
      }
      return {
        item_id: itemId,
        located: true,
        chain,
        path: chain.map((c) => c.name).join(' / '),
      };
    },

    /** Direct contents of a location: items placed here + child locations. */
    async contents(locationId) {
      const itemRels = await relations.toward(locationId, STORED_IN);
      const childRels = await relations.toward(locationId, INSIDE);
      const items = [];
      for (const r of itemRels) {
        const e = await entities.get(r.subject_id);
        if (e) items.push({ id: e.id, name: e.title, quantity: e.data.quantity ?? null });
      }
      const sublocations = [];
      for (const r of childRels) {
        const e = await entities.get(r.subject_id);
        if (e) sublocations.push({ id: e.id, name: e.title, kind: e.data.kind || null });
      }
      return { location_id: locationId, items, sublocations };
    },
  };
};
