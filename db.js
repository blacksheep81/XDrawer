const DB_NAME = 'x-drawer';
const DB_VERSION = 6;
const HISTORY_LIMIT = 200;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (event.oldVersion < 1) {
        const posts = db.createObjectStore('posts', { keyPath: 'key' });
        posts.createIndex('collection', 'collection');
        db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
      }
      if (event.oldVersion < 2) {
        const posts = request.transaction.objectStore('posts');
        posts.createIndex('account', 'account');
        posts.openCursor().onsuccess = cursorEvent => {
          const cursor = cursorEvent.target.result;
          if (!cursor) return;
          const old = cursor.value;
          if (!old.account) {
            cursor.delete();
            posts.put({ ...old, account: 'legacy', tags: Array.isArray(old.tags) ? old.tags : [], key: `legacy:${old.collection}:${old.id}` });
          }
          cursor.continue();
        };
      }
      if (event.oldVersion < 3) {
        db.createObjectStore('people', { keyPath:'handle' });
        const snapshots = db.createObjectStore('followerSnapshots', { keyPath:'id', autoIncrement:true });
        snapshots.createIndex('account', 'account');
      }
      if (event.oldVersion < 4) db.createObjectStore('savedViews', { keyPath:'id' });
      if (event.oldVersion < 5) {
        // 태그 목록 저장소를 새로 만들고 기존 글의 태그로 채운다. posts는 건드리지 않는다.
        const tagStore = db.createObjectStore('tags', { keyPath:'name' });
        const posts = request.transaction.objectStore('posts');
        const seen = new Set();
        posts.openCursor().onsuccess = cursorEvent => {
          const cursor = cursorEvent.target.result;
          if (!cursor) return;
          for (const tag of Array.isArray(cursor.value?.tags) ? cursor.value.tags : []) {
            const name = typeof tag === 'string' ? tag.trim().slice(0,40) : '';
            if (name && !seen.has(name)) { seen.add(name); tagStore.put({ name, color:'', createdAt:'' }); }
          }
          cursor.continue();
        };
      }
      if (event.oldVersion < 6) db.createObjectStore('smartRules', { keyPath:'id' });
    };
    request.onblocked = () => reject(new Error('收藏库正被其他标签页占用，无法更新。请关闭所有 X 抽屉标签页后重新打开。'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* 같은 확장 안의 다른 페이지(收藏库·팝업·백그라운드)에 DB 변경을 알린다. 보낸 쪽 자신에게는 전달되지 않는다. */
const dbChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('x-drawer-db') : null;
function announceDBChange() { try { dbChannel?.postMessage({ type:'changed', at:Date.now() }); } catch {} }
function onDBChange(listener) { if (dbChannel) dbChannel.addEventListener('message', event => { if (event.data?.type === 'changed') listener(); }); }

async function withTransaction(stores, mode, callback) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value;
      try { value = callback(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => { if (mode === 'readwrite') announceDBChange(); resolve(value); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('数据库操作已取消。'));
    });
  } finally { db.close(); }
}

async function getAll(storeName) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

/* ── 智能分类 규칙 ───────────────────────────────
   규칙은 키워드(任一/全部)·제외어·작성자로 글을 고른다. 태그가 있으면 맞는 글에 태그를 붙인다.
   글의 ruleApplied에 "규칙ID:태그"를 남겨, 사용자가 태그를 지운 글에 다시 붙이지 않는다. */
const RULE_LIMIT = 100;
/* 쉼표로만 나눈다. 띄어쓰기가 든 구절("design system")은 한 단어로 유지한다. */
function splitTerms(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，、;；]+/);
  return [...new Set(list.map(term => String(term).replace(/\s+/g, ' ').trim().toLocaleLowerCase().slice(0,60)).filter(Boolean))].slice(0,50);
}
/* 규칙이 저장할 수 있는 내용 조건. 읽음 상태·태그처럼 사용자가 바꾸는 값은 자동 태그를 흔들 수 있어 받지 않는다. */
const RULE_HAS_FLAGS = ['image','video','media','link'];
function ruleFlags(value) { return [...new Set((Array.isArray(value) ? value : []).map(flag => String(flag).toLowerCase()))].filter(flag => RULE_HAS_FLAGS.includes(flag)); }
function ruleHasFlag(item, flag) {
  if (flag === 'image') return item.media === 'image';
  if (flag === 'video') return item.media === 'video';
  if (flag === 'media') return item.media !== 'text';
  return !!(item.links || []).length;
}
const RULE_TAG_LIMIT = 20;
/* 손으로 넣거나 뺀 글은 계정·모음과 상관없이 같은 글이 함께 움직이도록 글 ID로 기억한다. */
const RULE_ID_LIMIT = 5000;
function ruleIds(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(postId => /^[A-Za-z0-9_-]{1,40}$/.test(postId)))].slice(0, RULE_ID_LIMIT); }
const ruleIdSets = new WeakMap();
function ruleIdSet(rule) {
  let sets = ruleIdSets.get(rule);
  if (!sets) { sets = { include:new Set(rule.includeIds || []), exclude:new Set(rule.excludeIds || []) }; ruleIdSets.set(rule, sets); }
  return sets;
}
const sameTags = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((tag, index) => tag === b[index]);
/* 태그를 바꿀 때마다 tagRev를 올린다. 되돌리기는 이 값으로 "적용 뒤 태그를 손댔는지"를 판단한다.
   (지웠다가 같은 이름을 다시 붙여도 값이 두 번 올라가므로 구별된다.) */
function withTags(item, tags) {
  return sameTags(item.tags || [], tags) ? { ...item, tags } : { ...item, tags, tagRev:(item.tagRev || 0) + 1 };
}
function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('无效的分类规则。');
  const id = typeof raw.id === 'string' && /^[a-z0-9-]{1,80}$/.test(raw.id) ? raw.id : '';
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0,40) : '';
  if (!id || !name) throw new Error('分类规则缺少名称。');
  const keywords = splitTerms(raw.keywords);
  const handles = value => splitTerms(Array.isArray(value) ? value : String(value || '').split(/[\s,，、;；]+/)).map(handle => handle.replace(/^@/, '')).filter(handle => /^[a-z0-9_]{1,15}$/.test(handle));
  const authors = handles(raw.authors);
  const has = ruleFlags(raw.has);
  const includeIds = ruleIds(raw.includeIds), excludeIds = ruleIds(raw.excludeIds).filter(postId => !includeIds.includes(postId));
  // folder는 조건 없이 손으로 넣은 글만 담는 분류다. 글을 모두 빼도 분류는 남는다.
  const folder = raw.folder === true && !keywords.length && !authors.length && !has.length;
  if (!folder && !keywords.length && !authors.length && !has.length) throw new Error('请至少填写一个关键词、作者或 has: 条件。');
  return {
    id, name, keywords, authors, has, folder, includeIds, excludeIds,
    notHas: ruleFlags(raw.notHas),
    notAuthors: handles(raw.notAuthors),
    match: raw.match === 'all' ? 'all' : 'any',
    exclude: splitTerms(raw.exclude),
    tag: typeof raw.tag === 'string' ? raw.tag.trim().replace(/^#/, '').slice(0,40) : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0,30) : new Date().toISOString()
  };
}
function ruleText(item) {
  return [item.text, item.note, item.author, item.username, item.url, ...(item.links || [])].join(' ').toLocaleLowerCase();
}
function ruleMatches(rule, item, text = ruleText(item)) {
  const ids = ruleIdSet(rule), postId = String(item.id);
  if (ids.exclude.has(postId)) return false;
  if (ids.include.has(postId)) return true;
  if (rule.folder) return false;
  const username = String(item.username || '').toLowerCase();
  if (rule.authors.length && !rule.authors.includes(username)) return false;
  if ((rule.notAuthors || []).includes(username)) return false;
  if (!(rule.has || []).every(flag => ruleHasFlag(item, flag))) return false;
  if ((rule.notHas || []).some(flag => ruleHasFlag(item, flag))) return false;
  if (rule.keywords.length && !(rule.match === 'all' ? rule.keywords.every(term => text.includes(term)) : rule.keywords.some(term => text.includes(term)))) return false;
  return !rule.exclude.some(term => text.includes(term));
}
const ruleMark = rule => `${rule.id}:${rule.tag}`;
/* 맞는 글이면 { item, added }를, 아니면 null을 돌려준다.
   태그가 이미 20개라 붙일 수 없으면 { full:true }만 돌려주고 표시를 남기지 않는다. 자리가 나면 다시 시도할 수 있다. */
function applyRuleTo(rule, item) {
  const mark = ruleMark(rule);
  const applied = Array.isArray(item.ruleApplied) ? item.ruleApplied : [];
  if (!rule.tag || applied.includes(mark) || !ruleMatches(rule, item)) return null;
  const tags = item.tags || [];
  const added = !tags.includes(rule.tag);
  if (added && tags.length >= RULE_TAG_LIMIT) return { full:true, added:false, item:null };
  return { added, full:false, item: { ...withTags(item, added ? [...tags, rule.tag] : tags), ruleApplied: [...applied, mark].slice(-200) } };
}
async function getRules() {
  try { return (await getAll('smartRules')).map(rule => { try { return normalizeRule(rule); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
async function putRule(rule) { await withTransaction('smartRules', 'readwrite', tx => tx.objectStore('smartRules').put(normalizeRule(rule))); }
async function deleteRule(id) { await withTransaction('smartRules', 'readwrite', tx => tx.objectStore('smartRules').delete(id)); }

/* 기존 글에 규칙을 적용한다. marked는 표시를 남긴 글, added는 태그를 새로 붙인 글, full은 태그가 가득 차 건너뛴 글이다.
   added에는 적용 직후의 태그 목록을 함께 남겨, 되돌릴 때 그 뒤로 태그가 바뀐 글은 건드리지 않는다. */
async function applyRuleToPosts(rule, keys) {
  const marked = [], added = [], full = [];
  const at = new Date().toISOString();
  await withTransaction(['posts','tags'], 'readwrite', tx => {
    const store = tx.objectStore('posts');
    registerTags(tx.objectStore('tags'), [rule.tag], at);
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        const result = request.result && applyRuleTo(rule, request.result);
        if (!result) return;
        if (result.full) { full.push(key); return; }
        store.put(result.item);
        marked.push(key);
        if (result.added) added.push({ key, rev:result.item.tagRev });
      };
    }
  });
  return { marked, added, full };
}
/* 적용 뒤로 태그가 바뀌지 않은 글에서만 태그를 뗀다. 바뀐 글은 사용자가 손댄 것이라 태그와 표시를 그대로 둔다. */
async function undoRuleApply(mark, tag, marked, added) {
  const snapshot = new Map(added.map(entry => [entry.key, entry.rev]));
  let removed = 0, kept = 0;
  await withTransaction('posts', 'readwrite', tx => {
    const store = tx.objectStore('posts');
    for (const key of marked) {
      const request = store.get(key);
      request.onsuccess = () => {
        const item = request.result;
        if (!item) return;
        const applied = item.ruleApplied || [];
        if (!applied.includes(mark)) return;
        let tags = item.tags || [];
        if (snapshot.has(key)) {
          if ((item.tagRev || 0) !== snapshot.get(key)) { kept++; return; }
          removed++;
          store.put({ ...withTags(item, tags.filter(name => name !== tag)), ruleApplied: applied.filter(value => value !== mark) });
          return;
        }
        store.put({ ...item, ruleApplied: applied.filter(value => value !== mark) });
      };
    }
  });
  return { removed, kept };
}

/* 새 태그 이름을 태그 목록에 등록한다. 이미 있으면 색과 메모를 유지한다. */
function registerTags(store, names, at) {
  for (const name of new Set(names.filter(Boolean))) {
    const request = store.get(name);
    request.onsuccess = () => { if (!request.result) store.put({ name, color:'', createdAt:at }); };
  }
}

async function savePosts(account, collection, items, mode = 'manual') {
  const at = new Date().toISOString();
  const rules = (await getRules()).filter(rule => rule.tag);
  await withTransaction(['posts', 'history', 'tags'], 'readwrite', tx => {
    const store = tx.objectStore('posts');
    const tagStore = tx.objectStore('tags');
    for (const item of items) {
      const key = `${account}:${collection}:${item.id}`;
      const request = store.get(key);
      request.onsuccess = () => {
        const previous = request.result;
        let record = { ...item, key, account, collection, avatarUrl:item.avatarUrl || previous?.avatarUrl || '', likeCount:item.likeCount ?? previous?.likeCount ?? null, viewCount:item.viewCount ?? previous?.viewCount ?? null, tags: previous?.tags || item.tags || [], ruleApplied: previous?.ruleApplied || [], note: previous?.note || item.note || '', readingState:previous?.readingState || item.readingState || 'none', linkStatus:previous?.linkStatus || item.linkStatus || '', checkedAt:previous?.checkedAt || item.checkedAt || '', savedAt: previous?.savedAt || at, updatedAt: at };
        // 새로 가져오거나 저장한 글에 자동 태그 규칙을 적용한다.
        for (const rule of rules) {
          const result = applyRuleTo(rule, record);
          if (!result || result.full) continue;
          record = result.item;
          if (result.added) registerTags(tagStore, [rule.tag], at);
        }
        store.put(record);
      };
    }
    const historyStore = tx.objectStore('history');
    historyStore.add({ account, collection, mode, count: items.length, at });
    // 기록이 무한정 쌓이지 않도록 오래된 항목부터 정리한다.
    const countRequest = historyStore.count();
    countRequest.onsuccess = () => {
      let excess = countRequest.result - HISTORY_LIMIT;
      if (excess <= 0) return;
      historyStore.openCursor().onsuccess = cursorEvent => {
        const cursor = cursorEvent.target.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess--;
        cursor.continue();
      };
    };
  });
}

async function importPosts(items) {
  const at = new Date().toISOString();
  await withTransaction(['posts', 'tags'], 'readwrite', tx => {
    const store = tx.objectStore('posts');
    const tagStore = tx.objectStore('tags');
    for (const item of items) {
      const request = store.get(item.key);
      request.onsuccess = () => {
        const existing = request.result;
        if (!existing) { store.put(item); registerTags(tagStore, item.tags || [], at); return; }
        const tags = [...new Set([...(existing.tags || []), ...(item.tags || [])])].slice(0,20);
        registerTags(tagStore, tags, at);
        const ruleApplied = [...new Set([...(existing.ruleApplied || []), ...(item.ruleApplied || [])])].slice(-200);
        store.put({ ...withTags(existing, tags), avatarUrl:existing.avatarUrl || item.avatarUrl || '', likeCount:existing.likeCount ?? item.likeCount ?? null, viewCount:existing.viewCount ?? item.viewCount ?? null, ruleApplied, note: existing.note || item.note || '', readingState:existing.readingState || item.readingState || 'none', linkStatus:existing.linkStatus || item.linkStatus || '', checkedAt:existing.checkedAt || item.checkedAt || '' });
      };
    }
  });
}

async function deletePost(key) { await withTransaction('posts', 'readwrite', tx => tx.objectStore('posts').delete(key)); }

async function deletePosts(keys) {
  await withTransaction('posts', 'readwrite', tx => {
    const store = tx.objectStore('posts');
    for (const key of keys) store.delete(key);
  });
}

async function updateTags(key, tags) {
  await withTransaction('posts', 'readwrite', tx => {
    const store = tx.objectStore('posts');
    const request = store.get(key);
    request.onsuccess = () => { if (request.result) store.put(withTags(request.result, tags)); };
  });
}

async function updateOrganization(key, tags, note) {
  const at = new Date().toISOString();
  await withTransaction(['posts','tags'], 'readwrite', tx => {
    const store = tx.objectStore('posts');
    registerTags(tx.objectStore('tags'), tags, at);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result) store.put({ ...withTags(request.result, tags), note, updatedAt:at });
    };
  });
}

async function updatePostFields(key, fields) {
  await withTransaction('posts', 'readwrite', tx => {
    const store = tx.objectStore('posts');
    const request = store.get(key);
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, ...fields }); };
  });
}

async function updateManyPosts(keys, tags, readingState) {
  const at = new Date().toISOString();
  await withTransaction(['posts','tags'], 'readwrite', tx => {
    const store = tx.objectStore('posts');
    registerTags(tx.objectStore('tags'), tags, at);
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        const old = request.result;
        if (!old) return;
        const next = { ...withTags(old, [...new Set([...(old.tags || []), ...tags])].slice(0,20)), updatedAt:at };
        if (readingState !== 'keep') next.readingState = readingState;
        store.put(next);
      };
    }
  });
}

/* 태그 이름을 모든 글에서 한 번에 바꾼다. 같은 이름이 이미 있으면 합친다. */
async function renameTagEverywhere(from, to) {
  const at = new Date().toISOString();
  await withTransaction(['posts','tags','smartRules'], 'readwrite', tx => {
    const posts = tx.objectStore('posts');
    const tagStore = tx.objectStore('tags');
    // 이름이 바뀐 태그를 붙이는 규칙과 글의 적용 표시도 함께 옮긴다.
    const renameMark = mark => { const cut = mark.indexOf(":"); return cut > 0 && mark.slice(cut + 1) === from ? `${mark.slice(0, cut)}:${to}` : mark; };
    const rules = tx.objectStore('smartRules');
    rules.openCursor().onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (cursor.value.tag === from) cursor.update({ ...cursor.value, tag:to });
      cursor.continue();
    };
    posts.openCursor().onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor) return;
      const tags = Array.isArray(cursor.value.tags) ? cursor.value.tags : [];
      const marks = Array.isArray(cursor.value.ruleApplied) ? cursor.value.ruleApplied : [];
      if (tags.includes(from) || marks.some(mark => renameMark(mark) !== mark)) {
        const next = [...new Set(tags.map(tag => (tag === from ? to : tag)))].slice(0,20);
        cursor.update({ ...withTags(cursor.value, next), ruleApplied:[...new Set(marks.map(renameMark))], updatedAt:at });
      }
      cursor.continue();
    };
    const oldMeta = tagStore.get(from);
    oldMeta.onsuccess = () => {
      const existing = tagStore.get(to);
      existing.onsuccess = () => {
        tagStore.put({ name:to, color:existing.result?.color || oldMeta.result?.color || '', createdAt:existing.result?.createdAt || oldMeta.result?.createdAt || at });
        if (from !== to) tagStore.delete(from);
      };
    };
  });
}

async function removeTagEverywhere(name) {
  const at = new Date().toISOString();
  await withTransaction(['posts','tags'], 'readwrite', tx => {
    tx.objectStore('tags').delete(name);
    tx.objectStore('posts').openCursor().onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor) return;
      const tags = Array.isArray(cursor.value.tags) ? cursor.value.tags : [];
      if (tags.includes(name)) cursor.update({ ...withTags(cursor.value, tags.filter(tag => tag !== name)), updatedAt:at });
      cursor.continue();
    };
  });
}

async function putTagMeta(tag) { await withTransaction('tags', 'readwrite', tx => tx.objectStore('tags').put(tag)); }

async function saveView(view) { await withTransaction('savedViews', 'readwrite', tx => tx.objectStore('savedViews').put(view)); }
async function deleteView(id) { await withTransaction('savedViews', 'readwrite', tx => tx.objectStore('savedViews').delete(id)); }

async function savePerson(person) {
  await withTransaction('people', 'readwrite', tx => tx.objectStore('people').put(person));
}
