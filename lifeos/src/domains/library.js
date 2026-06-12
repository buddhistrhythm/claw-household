'use strict';

/**
 * library.js — 阅读 / 书架.
 *
 * Each book is an entity (type=book). The reading lifecycle lives in the
 * top-level `status` column (fast filtering): want → reading → finished
 * (or abandoned). Bibliographic + progress fields live in JSONB `data`.
 * occurred_at = started_on (when reading began).
 */

const STATUSES = ['want', 'reading', 'finished', 'abandoned'];

const TODAY = () => new Date().toISOString().slice(0, 10);

module.exports = function readingDomain(store) {
  const { entities } = store;

  return {
    STATUSES,

    async addBook({ title, author, isbn, year, publisher, total_pages, status, family_id } = {}) {
      if (!title) throw new Error('library.addBook: `title` is required');
      const st = status || 'want';
      if (!STATUSES.includes(st)) throw new Error(`invalid status: ${st}`);
      return entities.create({
        type: 'book',
        title,
        status: st,
        family_id,
        occurred_at: null, // started_on not known yet
        tags: ['book', ...(author ? [String(author).toLowerCase()] : [])],
        data: {
          author: author || null,
          isbn: isbn || null,
          year: year ?? null,
          publisher: publisher || null,
          total_pages: total_pages ?? null,
          rating: null,
          progress_pct: null,
          started_on: null,
          finished_on: null,
        },
      });
    },

    /**
     * Advance the reading lifecycle. Entering 'reading' stamps started_on (and
     * occurred_at); entering 'finished' stamps finished_on (default today). A
     * `rating` may be merged in the same call.
     */
    async setStatus(id, status, { rating, finished_on, started_on } = {}) {
      if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
      const patch = { status };
      const dataPatch = {};
      if (status === 'reading') {
        const on = started_on || TODAY();
        dataPatch.started_on = on;
        patch.occurred_at = on;
      }
      if (status === 'finished') {
        dataPatch.finished_on = finished_on || TODAY();
      }
      if (rating !== undefined) dataPatch.rating = rating;
      await entities.patch(id, patch);
      if (Object.keys(dataPatch).length) await entities.mergeData(id, dataPatch);
      return entities.get(id);
    },

    async updateProgress(id, pct) {
      await entities.mergeData(id, { progress_pct: pct });
      return entities.get(id);
    },

    async rate(id, rating) {
      await entities.mergeData(id, { rating });
      return entities.get(id);
    },

    async list({ status, family_id } = {}) {
      return entities.list({ type: 'book', status, family_id, limit: 500 });
    },

    async currentlyReading() {
      return entities.list({ type: 'book', status: 'reading', limit: 500 });
    },

    /** Books finished in a given calendar year (by data.finished_on). */
    async finishedInYear(year) {
      const r = await store.db.query(
        `SELECT * FROM entities
         WHERE type = 'book' AND archived = false
           AND status = 'finished'
           AND data->>'finished_on' IS NOT NULL
           AND EXTRACT(YEAR FROM (data->>'finished_on')::date) = $1
         ORDER BY (data->>'finished_on')::date ASC`,
        [Number(year)]
      );
      return r.rows.map(entities.row);
    },
  };
};

module.exports.types = [
  { type: 'book', domain: 'reading', label: '书', icon: '📚',
    description: '阅读追踪：想读 / 在读 / 读完 / 弃读，含评分与进度',
    schema: { fields: {
      author: 'text', isbn: 'text', year: 'number', publisher: 'text',
      total_pages: 'number', rating: 'number', progress_pct: 'number',
      started_on: 'date', finished_on: 'date',
    } } },
];

// ─── manifest: CLI commands ───────────────────────────────────────────────────
module.exports.commands = (d, { num }) => ({
  'book-add': {
    desc: '加一本书', usage: 'book-add <title> [--author A] [--year N] [--pages N] [--status want|reading|finished|abandoned]',
    run: ({ positional, flags }) => d.addBook({
      title: positional.join(' '), author: flags.author, isbn: flags.isbn, year: num(flags.year),
      publisher: flags.publisher, total_pages: num(flags.pages), status: flags.status, family_id: flags.family,
    }),
  },
  'book-status': {
    desc: '推进阅读状态（自动盖时间戳）', usage: 'book-status <id> <status> [--rating N] [--started DATE] [--finished DATE]',
    run: ({ positional, flags }) => d.setStatus(positional[0], positional[1], { rating: num(flags.rating), started_on: flags.started, finished_on: flags.finished }),
  },
  'book-progress': { desc: '更新进度%', usage: 'book-progress <id> <pct>', run: ({ positional }) => d.updateProgress(positional[0], Number(positional[1])) },
  'book-rate': { desc: '评分', usage: 'book-rate <id> <n>', run: ({ positional }) => d.rate(positional[0], Number(positional[1])) },
  reading: { desc: '在读清单', usage: 'reading', run: () => d.currentlyReading() },
  books: { desc: '列出书', usage: 'books [--status S]', run: ({ flags }) => d.list({ status: flags.status, family_id: flags.family }) },
  'books-finished': { desc: '某年读完的书', usage: 'books-finished <year>', run: ({ positional }) => d.finishedInYear(Number(positional[0])) },
});
