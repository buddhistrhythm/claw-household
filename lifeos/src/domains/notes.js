'use strict';

/**
 * notes.js — 自由笔记 / 书记.
 *
 * A note is an entity (type=note). The `note` type is already built-in, so this
 * domain adds no new types. Notes can hang off any other entity via a
 * first-class relation:
 *   note -[about]-> entity      (this note is about that thing)
 */

const ABOUT = 'about';

module.exports = function notesDomain(store) {
  const { entities, relations } = store;

  return {
    ABOUT,

    /** Create a note; if `about` is given, also link note -[about]-> entity. */
    async create({ title, body, tags, topics, family_id, about } = {}) {
      const note = await entities.create({
        type: 'note',
        title: title || '',
        body: body || '',
        family_id,
        tags: tags || [],
        topics: topics || [],
      });
      if (about) await relations.link(note.id, ABOUT, about, { family_id });
      return note;
    },

    /** Append a paragraph to the note body (separated by a blank line). */
    async append(id, text) {
      const note = await entities.get(id);
      if (!note) throw new Error(`notes.append: note ${id} not found`);
      const body = note.body ? `${note.body}\n\n${text}` : String(text || '');
      return entities.patch(id, { body });
    },

    /** Link this note to a target entity (default predicate `about`). */
    async link(noteId, targetId, predicate = ABOUT) {
      return relations.link(noteId, predicate, targetId);
    },

    /** Notes whose `about` edge points at the given entity. */
    async forEntity(entityId) {
      const rels = await relations.toward(entityId, ABOUT);
      const out = [];
      for (const r of rels) {
        const e = await entities.get(r.subject_id);
        if (e) out.push(e);
      }
      return out;
    },

    async list({ tag, family_id, limit = 100 } = {}) {
      return entities.list({ type: 'note', tag, family_id, limit });
    },

    /** Thin full-text search wrapper scoped to notes. */
    async search(q, { family_id, limit } = {}) {
      return store.search(q, { type: 'note', family_id, limit });
    },
  };
};

// `note` already exists as a built-in type — introduce no new types.
module.exports.types = [];
