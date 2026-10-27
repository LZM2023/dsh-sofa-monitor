import { createHash, randomUUID } from 'node:crypto';

import manifest from '../package.json' with {type:'json'};
export const VERSION = manifest.version;
export const PLATFORMS = ['taobao', 'tmall', 'jd', 'xiaohongshu'];
const HOSTS = {taobao: ['taobao.com'], tmall: ['tmall.com'], jd: ['jd.com', 'jd.hk'], xiaohongshu: ['xiaohongshu.com', 'xhslink.com']};
export const DEFAULT_SETTINGS = Object.freeze({ platforms: ['jd'], brand: '顾家家居', keyword: '沙发', quantity: 3, intervalMinutes: 5, durationMinutes: 3, randomMode: false });

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function text(value, name, max = 200, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new InputError(`${name}格式不正确`);
  return value.trim();
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new InputError(`${name}须为 ${min}–${max} 的整数`);
  return value;
}
export function durationMinutes(value){if(!Number.isSafeInteger(value)||value<=0)throw new InputError('整批时长须为大于0的整数（分钟）');return value;}
export function validateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('参数须为对象');
  if (!Array.isArray(raw.platforms) || !raw.platforms.length || raw.platforms.some(p => !PLATFORMS.includes(p))) throw new InputError('请选择有效平台');
  if (typeof raw.randomMode !== 'boolean') throw new InputError('随机模式须为布尔值');
  return {platforms: [...new Set(raw.platforms)], brand: text(raw.brand, '品牌', 60, true), keyword: text(raw.keyword, '关键词', 80, true), quantity: integer(raw.quantity, '商品数量', 1, 20), intervalMinutes: durationMinutes(raw.intervalMinutes===undefined?5:raw.intervalMinutes), durationMinutes: durationMinutes(raw.durationMinutes===undefined?3:raw.durationMinutes), randomMode: raw.randomMode};
}
export function sourceUrl(value, platform) {
  let url;
  try { url = new URL(value); } catch { throw new InputError('请填写完整来源网址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS[platform]?.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new InputError('来源须为所选平台的 HTTPS 网址');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/(?:token|cookie|auth|session|password|secret)/i.test(key)) throw new InputError('来源网址不能包含登录凭据');
  return url.href;
}
export function validateProduct(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('商品须为对象');
  if (!PLATFORMS.includes(raw.platform)) throw new InputError('商品平台无效');
  const url = sourceUrl(text(raw.sourceUrl, '来源网址', 2000, true), raw.platform);
  if (raw.price !== undefined && (typeof raw.price !== 'number' || !Number.isFinite(raw.price) || raw.price < 0 || raw.price > 1e8)) throw new InputError('价格须为有效非负数字');
  const specs = {};
  if (raw.specs !== undefined) {
    if (!raw.specs || typeof raw.specs !== 'object' || Array.isArray(raw.specs) || Object.keys(raw.specs).length > 30) throw new InputError('规格须为不超过 30 项的对象');
    for (const [key, value] of Object.entries(raw.specs)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new InputError('规格名称不允许');
      const label = text(key, '规格名称', 40, true);
      specs[label] = text(value, '规格内容', 500, true);
    }
  }
  return { id: createHash('sha256').update(url).digest('hex').slice(0, 24), title: text(raw.title, '商品名称', 200, true), brand: text(raw.brand, '品牌', 80, true), model: text(raw.model, '型号', 100), platform: raw.platform, sourceUrl: url, ...(raw.price === undefined ? {} : {price: raw.price, currency: 'CNY'}), specs, importedAt: new Date().toISOString(), provenance: 'user-import', verification: 'unverified' };
}
export function validateImport(raw) {
  if (!raw || raw.rightsConfirmed !== true) throw new InputError('导入前请确认有权使用这些数据');
  if (!Array.isArray(raw.products) || raw.products.length < 1 || raw.products.length > 20) throw new InputError('一次可导入 1–20 条商品');
  return raw.products.map(validateProduct);
}
export function makeJob(settings) {
  return {id: randomUUID(), createdAt: new Date().toISOString(), settings: validateSettings(settings), status: 'blocked', completed: 0, reason: '这里只保存参数草案，没有启动采集或发起网络请求。京东明确链接队列须另行创建并在 Agent 启动；中央搜索须在面板点击开始。'};
}
export function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch])); }
export function specCard(product) {
  const e = escapeHtml;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${e(product.title)} · SofaMonitor</title><style>body{margin:0;background:#101317;color:#eef1f5;font:16px/1.7 'Segoe UI','Microsoft YaHei',sans-serif;padding:40px}main{max-width:880px;margin:auto}small,p{color:#b6c0cf}h1{font-size:30px;text-wrap:balance}header{border-bottom:1px solid #343c48;padding-bottom:24px}dl{display:grid;grid-template-columns:160px 1fr;gap:12px 24px}dt{color:#b6c0cf}dd{margin:0;overflow-wrap:anywhere}a{color:#a9c6ff}strong{font-variant-numeric:tabular-nums}.note{padding:18px;background:#1a2029;border:1px solid #343c48;border-radius:8px;margin-top:32px}</style><main><header><small>SofaMonitor / 产品规格卡</small><h1>${e(product.title)}</h1><p>${e(product.brand)}${product.model ? ' · '+e(product.model) : ''}</p><strong>${product.price === undefined ? '价格未提供' : '¥ '+e(product.price)}</strong></header><dl><dt>数据来源</dt><dd>${product.provenance === 'browser-assisted' ? (product.saveMode==='automatic'?'网页辅助采集 · 按用户要求自动归档 · 参数仍未核验':'网页辅助采集 · 用户确认入库 · 参数仍未核验') : '用户授权导入 · 尚未在线核验'}</dd><dt>来源平台</dt><dd>${e(product.platform)}</dd><dt>来源链接</dt><dd><a href="${e(product.sourceUrl)}" target="_blank" rel="noopener noreferrer">${e(product.sourceUrl)}</a></dd>${Object.entries(product.specs).map(([k,v])=>`<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl><p class="note">这是导入数据生成的规格卡。未提供的字段保持缺失，不推测价格、材质或尺寸。导入时间：${e(product.importedAt)}</p></main></html>`;
}
