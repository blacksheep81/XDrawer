const DB_NAME = 'x-drawer';
const DB_VERSION = 5;
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
    };
    request.onblocked = () => reject(new Error('收藏库正被其他标签页占用，无法更新。请关闭所有 X 抽屉标签页后重新打开。'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withTransaction(stores, mode, callback) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value;
      try { value = callback(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(value);
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

/* 새 태그 이름을 태그 목록에 등록한다. 이미 있으면 색과 메모를 유지한다. */
function registerTags(store, names, at) {
  for (const name of new Set(names.filter(Boolean))) {
    const request = store.get(name);
    request.onsuccess = () => { if (!request.result) store.put({ name, color:'', createdAt:at }); };
  }
}

async function savePosts(account, collection, items, mode = 'manual') {
  const at = new Date().toISOString();
  await withTransaction(['posts', 'history'], 'readwrite', tx => {
    const store = tx.objectStore('posts');
    for (const item of items) {
      const key = `${account}:${collection}:${item.id}`;
      const request = store.get(key);
      request.onsuccess = () => {
        const previous = request.result;
        store.put({ ...item, key, account, collection, avatarUrl:item.avatarUrl || previous?.avatarUrl || '', likeCount:item.likeCount ?? previous?.likeCount ?? null, viewCount:item.viewCount ?? previous?.viewCount ?? null, tags: previous?.tags || item.tags || [], note: previous?.note || item.note || '', readingState:previous?.readingState || item.readingState || 'none', linkStatus:previous?.linkStatus || item.linkStatus || '', checkedAt:previous?.checkedAt || item.checkedAt || '', savedAt: previous?.savedAt || at, updatedAt: at });
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
        store.put({ ...existing, avatarUrl:existing.avatarUrl || item.avatarUrl || '', likeCount:existing.likeCount ?? item.likeCount ?? null, viewCount:existing.viewCount ?? item.viewCount ?? null, tags, note: existing.note || item.note || '', readingState:existing.readingState || item.readingState || 'none', linkStatus:existing.linkStatus || item.linkStatus || '', checkedAt:existing.checkedAt || item.checkedAt || '' });
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
  await withTransaction(['posts','tags'], 'readwrite', tx => {
    const posts = tx.objectStore('posts');
    const tagStore = tx.objectStore('tags');
    posts.openCursor().onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor) return;
      const tags = Array.isArray(cursor.value.tags) ? cursor.value.tags : [];
      if (tags.includes(from)) {
        const next = [...new Set(tags.map(tag => (tag === from ? to : tag)))].slice(0,20);
        cursor.update({ ...cursor.value, tags:next, updatedAt:at });
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
