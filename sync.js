/* Google Drive 동기화. 사용자의 Drive 앱 전용 숨김 폴더에 스냅샷 파일 하나를 두고 기기끼리 병합한다. */

// Google Cloud의 "웹 애플리케이션" OAuth 클라이언트 ID. 비밀값이 아니다. README의 설정 절차 참고.
// 등록할 리디렉션 URI: https://cfpjibdhkfnibjiigeiebdmmodmkclcd.chromiumapp.org/ (manifest의 key로 고정된 확장 ID)
const GOOGLE_CLIENT_ID = '';
const SYNC_SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email';
const SYNC_FILE_NAME = 'x-drawer-sync.json.gz';
const SYNC_FORMAT = 'x-drawer-sync';
const SYNC_VERSION = 1;
const TOMBSTONE_TTL = 180 * 86400000;
const SYNC_STORES = ['posts','people','savedViews','tags','smartRules'];
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

class SyncError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ── 병합 (순수 함수) ────────────────────────── */
const ts = value => Date.parse(value || '') || 0;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

/* 시각이 같을 때도 인자 순서와 무관하게 같은 쪽을 고른다. 그래야 기기들이 같은 결과로 수렴한다. */
function newerRecord(a, b, clock) {
  const diff = clock(a) - clock(b);
  if (diff) return diff > 0 ? a : b;
  return stable(a) >= stable(b) ? a : b;
}

const READING_RANK = { none:0, later:1, read:2 };
const greaterText = (a, b) => (String(a || '') >= String(b || '') ? a : b);

const POST_META_FIELDS = new Set(['tags','ruleApplied','note','readingState','linkStatus','checkedAt','updatedAt','orgAt','savedAt']);
const postContent = item => stable(Object.fromEntries(Object.entries(item).filter(([field]) => !POST_META_FIELDS.has(field))));

/* 본문(updatedAt)과 정리 정보(orgAt)를 따로 비교한다. 다시 가져오기가 다른 기기의 태그를 덮어쓰지 않게 한다. */
function mergePost(a, b) {
  if (stable(a) === stable(b)) return a;
  const contentDiff = ts(a.updatedAt) - ts(b.updatedAt);
  const merged = { ...(contentDiff > 0 ? a : contentDiff < 0 ? b : (postContent(a) >= postContent(b) ? a : b)) };
  const orgDiff = ts(a.orgAt) - ts(b.orgAt);
  if (orgDiff) {
    const winner = orgDiff > 0 ? a : b;
    for (const field of ['tags','ruleApplied','note','readingState','linkStatus','checkedAt']) merged[field] = winner[field];
  } else {
    merged.tags = [...new Set([...(a.tags || []), ...(b.tags || [])])].sort().slice(0,20);
    merged.ruleApplied = [...new Set([...(a.ruleApplied || []), ...(b.ruleApplied || [])])].sort().slice(-200);
    merged.note = (a.note || '').length === (b.note || '').length ? greaterText(a.note, b.note) : ((a.note || '').length > (b.note || '').length ? a.note : b.note);
    merged.readingState = (READING_RANK[a.readingState] || 0) >= (READING_RANK[b.readingState] || 0) ? a.readingState : b.readingState;
    const checked = ts(a.checkedAt) === ts(b.checkedAt) ? (String(a.linkStatus || '') >= String(b.linkStatus || '') ? a : b) : (ts(a.checkedAt) > ts(b.checkedAt) ? a : b);
    merged.linkStatus = checked.linkStatus;
    merged.checkedAt = checked.checkedAt;
  }
  merged.updatedAt = ts(a.updatedAt) >= ts(b.updatedAt) ? a.updatedAt : b.updatedAt;
  merged.orgAt = ts(a.orgAt) >= ts(b.orgAt) ? a.orgAt : b.orgAt;
  const saved = [a.savedAt, b.savedAt].filter(Boolean).sort((x, y) => ts(x) - ts(y) || (x < y ? -1 : 1));
  merged.savedAt = saved[0] || '';
  return merged;
}

const STORE_RULES = {
  posts:{ key:item => item.key, merge:mergePost, clock:item => Math.max(ts(item.updatedAt), ts(item.orgAt), ts(item.savedAt)) },
  people:{ key:item => item.handle, clock:item => ts(item.updatedAt) },
  savedViews:{ key:item => item.id, clock:item => ts(item.updatedAt) },
  tags:{ key:item => item.name, clock:item => Math.max(ts(item.updatedAt), ts(item.createdAt)) },
  smartRules:{ key:item => item.id, clock:item => Math.max(ts(item.updatedAt), ts(item.createdAt)) }
};

function mergeSnapshots(local, remote, now = Date.now()) {
  const tombstones = new Map();
  for (const entry of [...(local.tombstones || []), ...(remote.tombstones || [])]) {
    const known = tombstones.get(entry.id);
    if (now - ts(entry.deletedAt) > TOMBSTONE_TTL) continue;
    if (!known || ts(entry.deletedAt) > ts(known.deletedAt)) tombstones.set(entry.id, entry);
  }
  const output = {};
  for (const store of SYNC_STORES) {
    const rule = STORE_RULES[store];
    const merged = new Map();
    for (const item of [...(local[store] || []), ...(remote[store] || [])]) {
      const key = rule.key(item);
      const known = merged.get(key);
      if (!known) merged.set(key, item);
      else merged.set(key, rule.merge ? rule.merge(known, item) : newerRecord(known, item, rule.clock));
    }
    // 삭제 후에 다시 저장되었으면 글이 살아남고, 아니면 삭제가 이긴다.
    for (const [key, item] of merged) {
      const id = `${store}:${key}`;
      const grave = tombstones.get(id);
      if (!grave) continue;
      if (rule.clock(item) > ts(grave.deletedAt)) tombstones.delete(id);
      else merged.delete(key);
    }
    output[store] = merged;
  }
  for (const post of output.posts.values()) {
    for (const name of post.tags || []) {
      if (!output.tags.has(name) && !tombstones.has(`tags:${name}`)) output.tags.set(name, { name, color:'', createdAt:'', updatedAt:'' });
    }
  }
  const sorted = map => [...map.keys()].sort().map(key => map.get(key));
  return { ...Object.fromEntries(SYNC_STORES.map(store => [store, sorted(output[store])])), tombstones:sorted(tombstones) };
}

/* 검증을 통과한 레코드만 남긴다. 깨진 레코드가 다른 기기로 번지지 않게 한다. */
const SYNC_NORMALIZERS = {
  posts:item => { const post = { ...normalizePost(item), savedAt:String(item.savedAt || '').slice(0,30) }; return post.key === item.key ? post : null; },
  people:item => normalizePerson(item),
  savedViews:item => normalizeView(item),
  tags:item => normalizeTag(item),
  smartRules:item => ({ ...normalizeRule(item), createdAt:String(item.createdAt || '').slice(0,30) })
};
function normalizeList(store, list) {
  const output = [];
  for (const item of Array.isArray(list) ? list : []) {
    try { const clean = SYNC_NORMALIZERS[store](item); if (clean) output.push(clean); } catch { /* 건너뛴다 */ }
  }
  return output;
}
function normalizeTombstones(list) {
  return (Array.isArray(list) ? list : []).filter(entry => SYNC_STORES.includes(entry?.store) && typeof entry.key === 'string' && entry.id === `${entry.store}:${entry.key}` && ts(entry.deletedAt))
    .map(entry => ({ id:entry.id, store:entry.store, key:entry.key, deletedAt:String(entry.deletedAt).slice(0,30) }));
}
function normalizeSnapshot(raw) {
  const output = { tombstones:normalizeTombstones(raw?.tombstones) };
  for (const store of SYNC_STORES) output[store] = normalizeList(store, raw?.[store]);
  return output;
}
function snapshotBody(snapshot) {
  const byKey = (list, keyOf) => [...list].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  return stable({
    tombstones:byKey(snapshot.tombstones || [], item => item.id),
    ...Object.fromEntries(SYNC_STORES.map(store => [store, byKey(snapshot[store] || [], STORE_RULES[store].key)]))
  });
}

/* ── 로컬 적용 ───────────────────────────────── */
/* 읽기부터 쓰기까지 트랜잭션 하나로 처리해서 그사이의 편집을 잃지 않는다. withTransaction을 쓰지 않아 변경 표시도 남지 않는다.
   받아온 변경이 있으면 열린 라이브러리가 새로 읽도록 알린다. */
async function applyRemoteSnapshot(remote) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const names = [...SYNC_STORES, 'tombstones'];
      const tx = db.transaction(names, 'readwrite');
      const raw = {};
      let pending = names.length, result = null;
      for (const name of names) {
        tx.objectStore(name).getAll().onsuccess = event => {
          raw[name] = event.target.result;
          if (--pending) return;
          try { result = writeMerged(tx, raw, remote); } catch (error) { tx.abort(); reject(error); }
        };
      }
      tx.oncomplete = () => { if (result?.changed) announceDBChange(); resolve(result); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('数据库操作已取消。'));
    });
  } finally { db.close(); }
}

function writeMerged(tx, raw, remote) {
  const local = { tombstones:normalizeTombstones(raw.tombstones) };
  for (const store of SYNC_STORES) local[store] = normalizeList(store, raw[store]);
  const merged = mergeSnapshots(local, remote);
  let changed = false;
  for (const store of SYNC_STORES) {
    const rule = STORE_RULES[store];
    const objectStore = tx.objectStore(store);
    const before = new Map(local[store].map(item => [rule.key(item), item]));
    for (const item of merged[store]) {
      const old = before.get(rule.key(item));
      before.delete(rule.key(item));
      if (!old || stable(old) !== stable(item)) { objectStore.put(item); changed = true; }
    }
    for (const key of before.keys()) { objectStore.delete(key); changed = true; }
  }
  const graves = tx.objectStore('tombstones');
  graves.clear();
  for (const entry of merged.tombstones) graves.put(entry);
  return { merged, changed };
}

/* ── Google 인증 ─────────────────────────────── */
const syncConfigured = () => !!GOOGLE_CLIENT_ID;

async function readSyncState() { return (await chrome.storage.local.get('syncState')).syncState || {}; }
async function patchSyncState(fields) {
  const next = { ...await readSyncState(), ...fields };
  await chrome.storage.local.set({ syncState:next });
  return next;
}

async function requestToken(interactive, loginHint) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({ client_id:GOOGLE_CLIENT_ID, response_type:'token', redirect_uri:chrome.identity.getRedirectURL(), scope:SYNC_SCOPES, state });
  if (!interactive) params.set('prompt', 'none');
  else if (!loginHint) params.set('prompt', 'select_account');
  if (loginHint) params.set('login_hint', loginHint);
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url:`https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive, abortOnLoadForNonInteractive:false, timeoutMsForNonInteractive:15000 });
  } catch (error) {
    throw new SyncError('needs-login', interactive ? `Google 登录未完成：${error.message}` : '登录已过期，请重新连接 Google Drive。');
  }
  const answer = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (answer.get('state') !== state || !answer.get('access_token')) throw new SyncError('needs-login', interactive ? 'Google 没有返回授权，请重试。' : '登录已过期，请重新连接 Google Drive。');
  const token = { value:answer.get('access_token'), expiresAt:Date.now() + (Number(answer.get('expires_in')) || 3600) * 1000 };
  await chrome.storage.session.set({ syncToken:token });
  return token.value;
}

async function accessToken(state, renew = false) {
  if (!renew) {
    const { syncToken } = await chrome.storage.session.get('syncToken');
    if (syncToken && syncToken.expiresAt - Date.now() > 60000) return syncToken.value;
  }
  return requestToken(false, state.email);
}

/* ── Drive API ───────────────────────────────── */
async function driveRequest(state, url, init = {}) {
  const send = async token => {
    try { return await fetch(url, { ...init, headers:{ ...init.headers, Authorization:`Bearer ${token}` } }); }
    catch { throw new SyncError('network', '无法连接 Google Drive，请检查网络或代理。'); }
  };
  let response = await send(await accessToken(state));
  if (response.status === 401) response = await send(await accessToken(state, true));
  if (response.status === 401) throw new SyncError('needs-login', '登录已过期，请重新连接 Google Drive。');
  if (!response.ok) throw new SyncError('drive', `Google Drive 返回错误（${response.status}）。`);
  return response;
}

async function findSyncFile(state) {
  const params = new URLSearchParams({ spaces:'appDataFolder', q:`name='${SYNC_FILE_NAME}' and trashed=false`, orderBy:'modifiedTime desc', pageSize:'1', fields:'files(id,headRevisionId,modifiedTime)' });
  const { files } = await (await driveRequest(state, `${DRIVE_API}?${params}`)).json();
  return files?.[0] || null;
}
const fileRevision = file => (file ? file.headRevisionId || file.modifiedTime || file.id : '');

async function downloadSnapshot(state, file) {
  const bytes = new Uint8Array(await (await driveRequest(state, `${DRIVE_API}/${file.id}?alt=media`)).arrayBuffer());
  let text;
  try {
    // 전송 계층에서 이미 압축이 풀렸을 수 있으므로 gzip 표식을 확인한다.
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    text = gzipped ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(bytes);
    const raw = JSON.parse(text);
    if (raw?.format !== SYNC_FORMAT) throw new Error('format');
    if (raw.version > SYNC_VERSION) throw new SyncError('version', '云端数据来自更新版本的 X 抽屉，请先升级此设备上的扩展。');
    return normalizeSnapshot(raw);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // 읽지 못한 파일은 덮어쓰지 않는다.
    throw new SyncError('corrupt', '云端同步文件无法读取，已停止同步，云端和本地数据都没有改动。');
  }
}

async function uploadSnapshot(state, snapshot, file) {
  const json = JSON.stringify({ format:SYNC_FORMAT, version:SYNC_VERSION, savedAt:new Date().toISOString(), ...snapshot });
  const body = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  const headers = { 'Content-Type':'application/json; charset=UTF-8', 'X-Upload-Content-Type':'application/gzip', 'X-Upload-Content-Length':String(body.size) };
  const start = file
    ? await driveRequest(state, `${DRIVE_UPLOAD}/${file.id}?uploadType=resumable&fields=id,headRevisionId,modifiedTime`, { method:'PATCH', headers, body:'{}' })
    : await driveRequest(state, `${DRIVE_UPLOAD}?uploadType=resumable&fields=id,headRevisionId,modifiedTime`, { method:'POST', headers, body:JSON.stringify({ name:SYNC_FILE_NAME, parents:['appDataFolder'], mimeType:'application/gzip' }) });
  const target = start.headers.get('Location');
  if (!target) throw new SyncError('drive', 'Google Drive 没有返回上传地址。');
  return (await driveRequest(state, target, { method:'PUT', headers:{ 'Content-Type':'application/gzip' }, body })).json();
}

/* ── 동기화 흐름 ─────────────────────────────── */
async function syncOnce() {
  const state = await readSyncState();
  if (!state.connected) return state;
  for (let attempt = 0; attempt < 3; attempt++) {
    // 먼저 표시를 지운다. 진행 중에 생긴 편집은 다시 표시되어 다음 번에 올라간다.
    const { syncDirty } = await chrome.storage.local.get('syncDirty');
    await chrome.storage.local.set({ syncDirty:false });
    try {
      const file = await findSyncFile(state);
      if (file && fileRevision(file) === state.lastRevision && !syncDirty) return patchSyncState({ lastAt:new Date().toISOString(), lastError:'', needsLogin:false });
      const remote = file ? await downloadSnapshot(state, file) : normalizeSnapshot({});
      const { merged } = await applyRemoteSnapshot(remote);
      let revision = fileRevision(file);
      if (snapshotBody(merged) !== snapshotBody(remote)) {
        // 내려받은 뒤 다른 기기가 올렸으면 처음부터 다시 병합한다.
        if (fileRevision(await findSyncFile(state)) !== revision) { await chrome.storage.local.set({ syncDirty:true }); continue; }
        revision = fileRevision(await uploadSnapshot(state, merged, file));
      }
      return patchSyncState({ lastAt:new Date().toISOString(), lastError:'', needsLogin:false, lastRevision:revision });
    } catch (error) {
      await chrome.storage.local.set({ syncDirty:true });
      throw error;
    }
  }
  throw new SyncError('conflict', '其他设备正在同步，请稍后再试。');
}

let syncInFlight = null;
function runSync() {
  if (!syncInFlight) {
    syncInFlight = syncOnce()
      .catch(error => patchSyncState({ lastError:error.message, needsLogin:error.code === 'needs-login' }))
      .finally(() => { syncInFlight = null; });
  }
  return syncInFlight;
}

async function connectSync() {
  if (!syncConfigured()) throw new SyncError('config', '同步功能尚未配置。');
  await requestToken(true);
  const state = await readSyncState();
  const profile = await (await driveRequest(state, 'https://www.googleapis.com/oauth2/v3/userinfo')).json();
  // 다른 계정으로 바꿔 연결하면 이전 파일 기록을 버린다.
  const sameAccount = state.email === profile.email;
  await patchSyncState({ connected:true, email:String(profile.email || ''), lastError:'', needsLogin:false, lastRevision:sameAccount ? state.lastRevision || '' : '' });
  await chrome.storage.local.set({ syncDirty:true });
  return runSync();
}

async function disconnectSync(deleteCloud) {
  const state = await readSyncState();
  if (deleteCloud) {
    const file = await findSyncFile(state);
    if (file) await driveRequest(state, `${DRIVE_API}/${file.id}`, { method:'DELETE' });
  }
  const { syncToken } = await chrome.storage.session.get('syncToken');
  if (syncToken?.value) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(syncToken.value)}`, { method:'POST' }).catch(() => {});
  await chrome.storage.session.remove('syncToken');
  await chrome.storage.local.set({ syncState:{ connected:false } });
  return readSyncState();
}
