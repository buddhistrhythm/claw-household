'use strict';

/**
 * types.js — built-in entity_type registry. Each domain registers its types
 * here (label/icon/domain + a light field schema used for UI + Obsidian
 * frontmatter). New domains either append to CORE_TYPES below, or — preferred —
 * export a `types` array from their domain module, aggregated in DOMAIN_TYPES.
 */

// Domain modules that introduce their own entity types export `module.exports.types`.
const DOMAIN_TYPES = [].concat(
  require('../domains/library').types || [],   // book
  require('../domains/finance').types || [],   // finance_account, finance_txn
  require('../domains/notes').types || [],     // (none yet — `note` is core)
  require('../domains/knowledge').types || [], // (none yet — `knowledge_item` is core)
);

const CORE_TYPES = [
  { type: 'item', domain: 'storage', label: '物品', icon: '📦',
    description: '家里的东西（可被归置到位置）',
    schema: { fields: { quantity: 'number', unit: 'text', category: 'text' } } },
  { type: 'storage_location', domain: 'storage', label: '存放位置', icon: '🗄️',
    description: '柜子 / 抽屉 / 房间 / 箱子（可嵌套）',
    schema: { fields: { kind: 'text', note: 'text' } } },
  { type: 'credit_card_application', domain: 'finance', label: '信用卡申请', icon: '💳',
    description: '信用卡申请追踪：状态、额度、年费、开卡奖励',
    schema: { fields: {
      issuer: 'text', network: 'text', applied_on: 'date', decided_on: 'date',
      credit_line: 'number', annual_fee: 'number',
      signup_bonus: 'text', bonus_requirement: 'text', bonus_deadline: 'date', bonus_earned: 'boolean',
    } } },
  { type: 'organization', domain: 'general', label: '机构', icon: '🏢',
    description: '银行 / 商家 / 公司等' },
  { type: 'note', domain: 'notes', label: '笔记', icon: '📝',
    description: '自由笔记 / 书记' },
  { type: 'knowledge_item', domain: 'knowledge', label: '知识条目', icon: '🔖',
    description: 'RSS / 收藏 / 剪藏（rsspool 入口）' },
];

// Full registry = core + everything the domain modules contribute.
const BUILTIN_TYPES = [...CORE_TYPES, ...DOMAIN_TYPES];

async function seedTypes(db) {
  for (const t of BUILTIN_TYPES) {
    await db.query(
      `INSERT INTO entity_types (type, domain, label, icon, description, schema, builtin)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (type) DO NOTHING`,
      [t.type, t.domain, t.label, t.icon, t.description, JSON.stringify(t.schema || {})]
    );
  }
}

module.exports = { seedTypes, BUILTIN_TYPES };
