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

// ─── manifest: CLI commands ───────────────────────────────────────────────────
module.exports.commands = (d, { csv }) => ({
  'note-add': {
    desc: '新建笔记（可 about 任意实体）', usage: 'note-add <title> [--body B] [--tags a,b] [--about ID]',
    run: ({ positional, flags }) => d.create({
      title: positional.join(' '), body: typeof flags.body === 'string' ? flags.body : undefined,
      tags: csv(flags.tags), topics: csv(flags.topics),
      about: typeof flags.about === 'string' ? flags.about : undefined, family_id: flags.family,
    }),
  },
  'note-append': { desc: '追加一段', usage: 'note-append <id> <text>', run: ({ positional }) => d.append(positional[0], positional.slice(1).join(' ')) },
  'note-link': { desc: '链接到实体', usage: 'note-link <noteId> <targetId> [--predicate P]', run: ({ positional, flags }) => d.link(positional[0], positional[1], flags.predicate || 'about') },
  'note-for': { desc: '某实体的全部笔记', usage: 'note-for <entityId>', run: ({ positional }) => d.forEntity(positional[0]) },
  notes: { desc: '列出笔记', usage: 'notes [--tag T]', run: ({ flags }) => d.list({ tag: flags.tag, family_id: flags.family }) },
  'note-search': { desc: '检索笔记', usage: 'note-search <q>', run: ({ positional, flags }) => d.search(positional.join(' '), { family_id: flags.family }) },
});
