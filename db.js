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
function splitTerms(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，、;；\s]+/);
  return [...new Set(list.map(term => String(term).trim().toLocaleLowerCase().slice(0,60)).filter(Boolean))].slice(0,50);
}
function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('无效的分类规则。');
  const id = typeof raw.id === 'string' && /^[a-z0-9-]{1,80}$/.test(raw.id) ? raw.id : '';
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0,40) : '';
  if (!id || !name) throw new Error('分类规则缺少名称。');
  const keywords = splitTerms(raw.keywords);
  const authors = splitTerms(raw.authors).map(handle => handle.replace(/^@/, '')).filter(handle => /^[a-z0-9_]{1,15}$/.test(handle));
  if (!keywords.length && !authors.length) throw new Error('请至少填写一个关键词或作者。');
  return {
    id, name, keywords, authors,
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
  if (rule.authors.length && !rule.authors.includes(String(item.username || '').toLowerCase())) return false;
  if (rule.keywords.length && !(rule.match === 'all' ? rule.keywords.every(term => text.includes(term)) : rule.keywords.some(term => text.includes(term)))) return false;
  return !rule.exclude.some(term => text.includes(term));
}
const ruleMark = rule => `${rule.id}:${rule.tag}`;
/* 맞는 글이면 태그를 붙인 새 객체를, 아니면 null을 돌려준다. added는 태그가 실제로 새로 붙었는지 알려 준다. */
function applyRuleTo(rule, item) {
  const mark = ruleMark(rule);
  const applied = Array.isArray(item.ruleApplied) ? item.ruleApplied : [];
  if (!rule.tag || applied.includes(mark) || !ruleMatches(rule, item)) return null;
  const tags = item.tags || [];
  const added = !tags.includes(rule.tag) && tags.length < 20;
  return { added, item: { ...item, tags: added ? [...tags, rule.tag] : tags, ruleApplied: [...applied, mark].slice(-200) } };
}
async function getRules() {
  try { return (await getAll('smartRules')).map(rule => { try { return normalizeRule(rule); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
async function putRule(rule) { await withTransaction('smartRules', 'readwrite', tx => tx.objectStore('smartRules').put(normalizeRule(rule))); }
async function deleteRule(id) { await withTransaction('smartRules', 'readwrite', tx => tx.objectStore('smartRules').delete(id)); }

/* 기존 글에 규칙을 적용한다. 되돌리기에 쓸 수 있도록 표시만 남긴 글과 태그를 붙인 글을 따로 돌려준다. */
async function applyRuleToPosts(rule, keys) {
  const marked = [], added = [];
  const at = new Date().toISOString();
  await withTransaction(['posts','tags'], 'readwrite', tx => {
    const store = tx.objectStore('posts');
    registerTags(tx.objectStore('tags'), [rule.tag], at);
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        const result = request.result && applyRuleTo(rule, request.result);
        if (!result) return;
        store.put(result.item);
        marked.push(key);
        if (result.added) added.push(key);
      };
    }
  });
  return { marked, added };
}
async function undoRuleApply(mark, tag, marked, added) {
  const addedSet = new Set(added);
  await withTransaction('posts', 'readwrite', tx => {
    const store = tx.objectStore('posts');
    for (const key of marked) {
      const request = store.get(key);
      request.onsuccess = () => {
        const item = request.result;
        if (!item) return;
        store.put({ ...item, tags: addedSet.has(key) ? (item.tags || []).filter(name => name !== tag) : item.tags, ruleApplied: (item.ruleApplied || []).filter(value => value !== mark) });
      };
    }
  });
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
          if (!result) continue;
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
        store.put({ ...existing, avatarUrl:existing.avatarUrl || item.avatarUrl || '', likeCount:existing.likeCount ?? item.likeCount ?? null, viewCount:existing.viewCount ?? item.viewCount ?? null, tags, ruleApplied, note: existing.note || item.note || '', readingState:existing.readingState || item.readingState || 'none', linkStatus:existing.linkStatus || item.linkStatus || '', checkedAt:existing.checkedAt || item.checkedAt || '' });
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
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, tags }); };
  });
}

async function updateOrganization(key, tags, note) {
  const at = new Date().toISOString();
  await withTransaction(['posts','tags'], 'readwrite', tx => {
    const store = tx.objectStore('posts');
    registerTags(tx.objectStore('tags'), tags, at);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, tags, note, updatedAt:at });
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
        const next = { ...old, tags:[...new Set([...(old.tags || []), ...tags])].slice(0,20), updatedAt:at };
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
        cursor.update({ ...cursor.value, tags:next, ruleApplied:[...new Set(marks.map(renameMark))], updatedAt:at });
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
      if (tags.includes(name)) cursor.update({ ...cursor.value, tags:tags.filter(tag => tag !== name), updatedAt:at });
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
