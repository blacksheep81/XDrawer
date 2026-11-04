/* 백업 가져오기와 동기화가 함께 쓰는 레코드 검증. */
const safeColor = value => (/^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : '');

function normalizePost(item) {
  if (!item || typeof item !== 'object' || !['bookmark','like','saved'].includes(item.collection) || typeof item.id !== 'string' || !/^\d+$/.test(item.id) || typeof item.url !== 'string' || !/^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(item.url)) throw new Error('备份中有无效的帖子。');
  if (item.url.split('/status/')[1] !== item.id) throw new Error('备份中有帖子地址与 ID 不一致的条目。');
  const account = typeof item.account === 'string' && /^[A-Za-z0-9_]{1,25}$/.test(item.account) ? item.account.toLowerCase() : 'legacy';
  if (![`${item.collection}:${item.id}`, `${account}:${item.collection}:${item.id}`].includes(item.key)) throw new Error('备份中有无效的帖子。');
  const string = key => typeof item[key] === 'string' ? item[key].slice(0,100000) : '';
  const safeList = value => Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.length < 3000).slice(0,30) : [];
  const images = safeList(item.imageUrls).filter(url => { try { const u = new URL(url); return u.protocol === 'https:' && ['pbs.twimg.com','ton.twimg.com'].includes(u.hostname); } catch { return false; } });
  const avatarUrl = string('avatarUrl').slice(0,3000);
  const safeAvatar = (() => { try { const u = new URL(avatarUrl); return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com' ? u.href : ''; } catch { return ''; } })();
  const links = safeList(item.links).filter(url => { try { return new URL(url).protocol === 'https:'; } catch { return false; } });
  const tags = Array.isArray(item.tags) ? [...new Set(item.tags.filter(x => typeof x === 'string').map(x => x.trim().slice(0,40)).filter(Boolean))].slice(0,20) : [];
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { id:item.id, key:`${account}:${item.collection}:${item.id}`, account, accountName:string('accountName').slice(0,15), url:item.url, collection:item.collection, username:string('username'), author:string('author'), avatarUrl:safeAvatar, text:string('text'), note:string('note').slice(0,2000), date:string('date'), savedAt:string('savedAt') || new Date().toISOString(), updatedAt:string('updatedAt'), media:['text','image','video'].includes(item.media) ? item.media : 'text', imageUrls:images, links, tags, likeCount:count(item.likeCount), viewCount:count(item.viewCount), readingState:['later','read'].includes(item.readingState) ? item.readingState : 'none', linkStatus:['available','unavailable','unknown'].includes(item.linkStatus) ? item.linkStatus : '', checkedAt:string('checkedAt').slice(0,30), ruleApplied:Array.isArray(item.ruleApplied) ? item.ruleApplied.filter(x => typeof x === 'string' && x.length <= 130).slice(-200) : [], orgAt:string('orgAt').slice(0,30) };
}

function normalizePerson(person) {
  const handle = String(person?.handle || '').toLowerCase();
  const match = String(person?.match || '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle) || (match && !/^[a-z0-9_]{1,15}$/.test(match))) throw new Error('人物记录中有无效的账号。');
  return { handle, match, label:String(person.label || '').slice(0,80), note:String(person.note || '').slice(0,500), privateAccount:!!person.privateAccount, updatedAt:String(person.updatedAt || '') };
}

function normalizeView(entry) {
  if (typeof entry?.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 50 || !entry.settings || typeof entry.settings !== 'object') throw new Error('已保存视图中有无效的条目。');
  const settings = entry.settings;
  const text = key => typeof settings[key] === 'string' ? settings[key].slice(0,500) : '';
  const tags = Array.isArray(settings.tags)
    ? settings.tags.filter(tag => typeof tag === 'string').map(tag => tag.slice(0,40)).slice(0,20)
    : (typeof settings.tag === 'string' && settings.tag && settings.tag !== 'all' ? [settings.tag.slice(0,40)] : []);
  return { id:entry.id, updatedAt:typeof entry.updatedAt === 'string' ? entry.updatedAt.slice(0,30) : '', name:entry.name.trim(), settings:{ view:text('view'), search:text('search'), media:text('media'), sort:text('sort'), account:text('account'), author:text('author'), tags, reading:text('reading'), link:text('link'), from:text('from'), to:text('to'), preset:text('preset'), layout:text('layout'), collapse:!!settings.collapse, untagged:!!settings.untagged } };
}

function normalizeTag(entry) {
  const name = typeof entry?.name === 'string' ? entry.name.trim().slice(0,40) : '';
  if (!name) throw new Error('标签列表中有无效的条目。');
  return { name, color:safeColor(entry.color), createdAt:typeof entry.createdAt === 'string' ? entry.createdAt.slice(0,30) : '', updatedAt:typeof entry.updatedAt === 'string' ? entry.updatedAt.slice(0,30) : '' };
}
