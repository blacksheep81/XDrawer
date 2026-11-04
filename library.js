const $ = selector => document.querySelector(selector);

let posts = [], history = [], people = [], tagMeta = [], savedViews = [];
let view = 'all', activeTab = null, editingTagKey = null, scanPaused = false;
let editingTags = [], bulkTags = [];
const activeTags = new Set();
const selectedKeys = new Set();
let visibleKeys = [];
let confirmResolve = null;

const titles = { all:'全部收藏', bookmark:'书签', like:'喜欢', saved:'手动保存', people:'人物·小号' };
const subtitles = {
  all:'搜索、筛选和整理你保存的全部帖子。',
  bookmark:'搜索并整理已保存的书签。',
  like:'重温喜欢的帖子，并通过链接分享。',
  saved:'这些是你在 X 帖子页面手动保存的帖子。',
  people:'记录已亲自确认账号的别名和线索。'
};
const kindLabels = { bookmark:'书签', like:'喜欢', saved:'手动保存' };
const kindMarks = kindLabels;

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeColor = value => (/^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : '');

const collectionForURL = url => {
  try { const parsed = new URL(url); if (!['x.com','twitter.com'].includes(parsed.hostname)) return null; if (parsed.pathname === '/i/bookmarks') return 'bookmark'; if (/^\/[^/]+\/likes\/?$/.test(parsed.pathname)) return 'like'; } catch {}
  return null;
};
const validAccount = value => typeof value === 'string' && /^[a-z0-9_]{1,15}$/.test(value.toLowerCase()) ? value.toLowerCase() : null;

async function profileFromTab(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type:'PROFILE' });
    return validAccount(response?.profile);
  } catch { return null; }
}
async function waitForTabReady(id) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const tab = await chrome.tabs.get(id);
    if (tab.status === 'complete') { await new Promise(resolve => setTimeout(resolve, 700)); return tab; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('X 页面未能打开。请检查登录状态和网络。');
}

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
  return { id:item.id, key:`${account}:${item.collection}:${item.id}`, account, accountName:string('accountName').slice(0,15), url:item.url, collection:item.collection, username:string('username'), author:string('author'), avatarUrl:safeAvatar, text:string('text'), note:string('note').slice(0,2000), date:string('date'), savedAt:string('savedAt') || new Date().toISOString(), updatedAt:string('updatedAt'), media:['text','image','video'].includes(item.media) ? item.media : 'text', imageUrls:images, links, tags, likeCount:count(item.likeCount), viewCount:count(item.viewCount), readingState:['later','read'].includes(item.readingState) ? item.readingState : 'none', linkStatus:['available','unavailable','unknown'].includes(item.linkStatus) ? item.linkStatus : '', checkedAt:string('checkedAt').slice(0,30) };
}

function notice(message, error = false) { const el = $('#notice'); el.textContent = message; el.hidden = false; el.classList.toggle('error', error); }
function clearNotice() { $('#notice').hidden = true; }

function localDay(iso) {
  const time = Date.parse(iso || '');
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

/* 검색어를 일반 단어, 제외 단어, from:/tag:/has:/is: 조건으로 나눈다. */
function parseQuery(query) {
  const parsed = { include:[], exclude:[], from:[], notFrom:[], tag:[], notTag:[], has:[], is:[] };
  const pattern = /(-?)(?:(from|tag|has|is)[:：])?(?:["“]([^"”]*)["”]|(\S+))/gi;
  for (const match of String(query || '').matchAll(pattern)) {
    const negate = match[1] === '-';
    const field = (match[2] || '').toLowerCase();
    const value = (match[3] ?? match[4] ?? '').trim().toLocaleLowerCase();
    if (!value) continue;
    if (field === 'from') (negate ? parsed.notFrom : parsed.from).push(value.replace(/^@/, ''));
    else if (field === 'tag') (negate ? parsed.notTag : parsed.tag).push(value.replace(/^#/, ''));
    else if (field === 'has') parsed.has.push(value);
    else if (field === 'is') parsed.is.push(value);
    else (negate ? parsed.exclude : parsed.include).push(value);
  }
  return parsed;
}

function matchesQuery(item, parsed) {
  const haystack = [item.text, item.note, item.author, item.username, item.url, ...(item.tags || []), ...(item.links || [])].join(' ').toLocaleLowerCase();
  if (!parsed.include.every(term => haystack.includes(term))) return false;
  if (parsed.exclude.some(term => haystack.includes(term))) return false;
  const who = `${item.username || ''} ${item.author || ''}`.toLocaleLowerCase();
  if (!parsed.from.every(term => who.includes(term))) return false;
  if (parsed.notFrom.some(term => who.includes(term))) return false;
  const tags = (item.tags || []).map(tag => tag.toLocaleLowerCase());
  if (!parsed.tag.every(term => tags.some(tag => tag.includes(term)))) return false;
  if (parsed.notTag.some(term => tags.some(tag => tag.includes(term)))) return false;
  for (const flag of parsed.has) {
    if (flag === 'image' && item.media !== 'image') return false;
    if (flag === 'video' && item.media !== 'video') return false;
    if (flag === 'media' && item.media === 'text') return false;
    if (flag === 'link' && !(item.links || []).length) return false;
    if (flag === 'note' && !item.note) return false;
    if (flag === 'tag' && !(item.tags || []).length) return false;
  }
  for (const state of parsed.is) {
    const reading = item.readingState || 'none';
    if (state === 'read' && reading !== 'read') return false;
    if (state === 'later' && reading !== 'later') return false;
    if (state === 'unread' && reading === 'read') return false;
  }
  return true;
}

function highlightText(text, terms) {
  const source = String(text ?? '');
  if (!terms.length) return escapeHTML(source);
  const lower = source.toLocaleLowerCase();
  const ranges = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    while (ranges.length < 300) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      ranges.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  if (!ranges.length) return escapeHTML(source);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  let output = '', at = 0;
  for (const [start, end] of merged) {
    output += escapeHTML(source.slice(at, start)) + `<mark>${escapeHTML(source.slice(start, end))}</mark>`;
    at = end;
  }
  return output + escapeHTML(source.slice(at));
}

async function refresh() {
  posts = await getAll('posts');
  history = await getAll('history');
  people = await getAll('people');
  tagMeta = await getAll('tags');
  const keys = new Set(posts.map(item => item.key));
  for (const key of selectedKeys) if (!keys.has(key)) selectedKeys.delete(key);
  render();
}

function updateSelection() {
  const selectedVisible = visibleKeys.filter(key => selectedKeys.has(key)).length;
  $('#selectVisible').checked = visibleKeys.length > 0 && selectedVisible === visibleKeys.length;
  $('#selectVisible').indeterminate = selectedVisible > 0 && selectedVisible < visibleKeys.length;
  $('#selectionCount').textContent = `已选 ${selectedKeys.size} 项`;
  const none = selectedKeys.size === 0;
  $('#selectionBar').hidden = none;
  $('#clearSelection').disabled = $('#shareSelected').disabled = $('#bulkEdit').disabled = $('#deleteSelected').disabled = none;
}

function currentViewSettings() {
  return {
    view, search:$('#search').value, media:$('#media').value, sort:$('#sort').value,
    account:$('#accountFilter').value, author:$('#authorFilter').value,
    tags:[...activeTags], reading:$('#readFilter').value, link:$('#linkFilter').value,
    from:$('#fromDate').value, to:$('#toDate').value, preset:$('#datePreset').value,
    layout:$('#layout').value, collapse:$('#collapseDuplicates').checked, untagged:$('#untaggedOnly').checked
  };
}

function renderSavedViews() {
  const selected = $('#savedViewSelect').value;
  $('#savedViewSelect').innerHTML = '<option value="">选择视图</option>' + savedViews.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join('');
  $('#savedViewSelect').value = savedViews.some(item => item.id === selected) ? selected : '';
  $('#deleteView').disabled = !$('#savedViewSelect').value;
}
async function refreshSavedViews() { savedViews = await getAll('savedViews'); renderSavedViews(); }

function applyViewSettings(settings) {
  view = ['all','bookmark','like','saved'].includes(settings.view) ? settings.view : 'all';
  activeTags.clear();
  const tags = Array.isArray(settings.tags) ? settings.tags : (settings.tag && settings.tag !== 'all' ? [settings.tag] : []);
  for (const tag of tags) if (typeof tag === 'string' && tag) activeTags.add(tag);
  render();
  const pairs = {
    search:settings.search, media:settings.media, sort:settings.sort, accountFilter:settings.account,
    authorFilter:settings.author, readFilter:settings.reading, linkFilter:settings.link,
    fromDate:settings.from, toDate:settings.to, datePreset:settings.preset, layout:settings.layout
  };
  for (const [id, value] of Object.entries(pairs)) {
    const control = $(`#${id}`);
    if (!control || value == null) continue;
    if (!control.options || [...control.options].some(option => option.value === value)) control.value = value;
  }
  $('#collapseDuplicates').checked = !!settings.collapse;
  $('#untaggedOnly').checked = !!settings.untagged;
  render();
}

function tagCounts() {
  const counts = new Map();
  for (const item of posts) for (const tag of item.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  for (const meta of tagMeta) if (!counts.has(meta.name)) counts.set(meta.name, 0);
  return counts;
}
function tagColor(name) { return safeColor(tagMeta.find(meta => meta.name === name)?.color); }

function renderTagBar() {
  const counts = tagCounts();
  const names = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'zh-CN'));
  const panelOpen = !$('#advancedPanel').hidden;
  $('#tagSection').hidden = !panelOpen && !activeTags.size;
  const shown = names.filter(name => activeTags.has(name) || (panelOpen && counts.get(name) > 0)).slice(0, 40);
  if (!shown.length) {
    $('#tagBar').innerHTML = '<span class="muted">还没有标签。在卡片的“整理”中添加第一个标签吧。</span>';
    return;
  }
  const extra = names.length - shown.length;
  $('#tagBar').innerHTML = shown.map(name => {
    const color = tagColor(name);
    return `<button type="button" class="tag-filter${activeTags.has(name) ? ' on' : ''}" data-tag="${escapeHTML(name)}" aria-pressed="${activeTags.has(name)}"><i${color ? ` style="background:${color}"` : ''}></i>${escapeHTML(name)} <em>${counts.get(name)}</em></button>`;
  }).join('') + (panelOpen && extra > 0 ? `<span class="muted">另有 ${extra} 个 — 在搜索框输入 tag:名称</span>` : '');
}

function filteredPosts(parsed) {
  const media = $('#media').value;
  const account = $('#accountFilter').value;
  const author = $('#authorFilter').value;
  const reading = $('#readFilter').value;
  const linkFilter = $('#linkFilter').value;
  const from = $('#fromDate').value, to = $('#toDate').value;
  const untaggedOnly = $('#untaggedOnly').checked;
  return posts.filter(item => {
    if (view !== 'all' && item.collection !== view) return false;
    if (account !== 'all' && (item.account || 'legacy') !== account) return false;
    if (author !== 'all' && item.username !== author) return false;
    if (media !== 'all' && item.media !== media) return false;
    if (reading !== 'all' && (item.readingState || 'none') !== reading) return false;
    const status = item.linkStatus || 'unchecked';
    if (linkFilter !== 'all' && !(linkFilter === 'attention' ? ['unavailable','unknown'].includes(status) : linkFilter === status)) return false;
    if (untaggedOnly && (item.tags || []).length) return false;
    for (const tag of activeTags) if (!(item.tags || []).includes(tag)) return false;
    if (from || to) {
      const day = localDay(item.date);
      if (!day) return false;
      if (from && day < from) return false;
      if (to && day > to) return false;
    }
    return matchesQuery(item, parsed);
  });
}

function sortPosts(items) {
  const sort = $('#sort').value;
  const time = value => { const parsed = Date.parse(value || ''); return Number.isNaN(parsed) ? 0 : parsed; };
  return items.sort((a, b) => {
    if (sort === 'likes' || sort === 'views') {
      const pick = item => (sort === 'likes' ? item.likeCount : item.viewCount) ?? -1;
      return pick(b) - pick(a) || time(b.savedAt) - time(a.savedAt);
    }
    if (sort === 'posted') return time(b.date) - time(a.date);
    if (sort === 'oldest') return (time(a.date) || Infinity) - (time(b.date) || Infinity);
    if (sort === 'author') return (a.author || a.username || '').localeCompare(b.author || b.username || '', 'zh-CN') || time(b.savedAt) - time(a.savedAt);
    return time(b.savedAt) - time(a.savedAt);
  });
}

function activeFilterCount() {
  let count = 0;
  for (const id of ['#media','#accountFilter','#authorFilter','#readFilter','#linkFilter']) if ($(id).value !== 'all') count++;
  if ($('#fromDate').value || $('#toDate').value) count++;
  if ($('#untaggedOnly').checked) count++;
  count += activeTags.size;
  if ($('#search').value.trim()) count++;
  return count;
}

function cardHTML(group, terms) {
  const item = group[0];
  const keys = group.map(post => post.key);
  const keyData = escapeHTML(JSON.stringify(keys));
  const allSelected = keys.every(key => selectedKeys.has(key));
  const someSelected = keys.some(key => selectedKeys.has(key));
  const sourceLabels = group.map(post => `@${post.account} ${kindLabels[post.collection] || post.collection}`);
  const duplicateNote = group.length > 1
    ? `<div class="duplicate-note"><strong>同一帖子保存在 ${group.length} 处</strong><span>${escapeHTML(sourceLabels.join(' · '))}</span><small>如需分别整理各项，请关闭“合并相同帖子”。</small></div>`
    : '';
  const initial = (item.author || item.username || '?').slice(0,1).toUpperCase();
  const avatar = item.avatarUrl
    ? `<img class="avatar-image" src="${escapeHTML(item.avatarUrl)}" alt="" loading="lazy" data-initial="${escapeHTML(initial)}">`
    : escapeHTML(initial);
  const meta = [
    item.likeCount == null ? null : `${item.likeCount.toLocaleString('zh-CN')} 喜欢`,
    item.viewCount == null ? null : `${item.viewCount.toLocaleString('zh-CN')} 浏览`
  ].filter(Boolean);
  const reading = item.readingState || 'none';
  const status = item.linkStatus || 'unchecked';
  const availability = { available:'原帖已确认', unavailable:'原帖无法访问', unknown:'无法确认' }[status] || '原帖未检查';
  const posted = item.date && !Number.isNaN(Date.parse(item.date)) ? new Date(item.date).toLocaleDateString('zh-CN') : '无日期';
  const mediaLabel = { image:'图片', video:'视频' }[item.media] || '文本';
  const tagRow = (item.tags || []).map(tag => {
    const color = tagColor(tag);
    return `<button type="button" class="card-tag" data-tag="${escapeHTML(tag)}" title="按此标签筛选"><i${color ? ` style="background:${color}"` : ''}></i>${escapeHTML(tag)}</button>`;
  }).join('');

  return `<article class="card${someSelected ? ' selected' : ''}" data-kind="${escapeHTML(item.collection)}">
<div class="card-top">
<label class="select-post" title="选择要分享或批量整理的帖子"><input type="checkbox" class="post-select" data-keys="${keyData}" aria-label="选择 ${escapeHTML(item.author || item.username)} 的帖子"${allSelected ? ' checked' : ''}></label>
<div class="avatar">${avatar}</div>
<div class="identity"><strong>${escapeHTML(item.author || item.username)}</strong><span>@${escapeHTML(item.username)}<em>保存账号 @${escapeHTML(item.accountName || item.account || 'legacy')}</em></span></div>
<span class="pill" data-kind="${escapeHTML(item.collection)}">${kindMarks[item.collection] || escapeHTML(item.collection)}</span>
</div>${duplicateNote}
<p class="post-text">${highlightText(item.text || '(未能获取正文)', terms)}</p>
${item.note ? `<p class="post-note">备注：${highlightText(item.note, terms)}</p>` : ''}
${item.imageUrls?.[0] ? `<img class="preview" src="${escapeHTML(item.imageUrls[0])}" alt="帖子图片" loading="lazy">` : ''}
${tagRow ? `<div class="tag-row">${tagRow}</div>` : ''}
<div class="card-actions">
<button class="reading-button${reading === 'later' ? ' active' : ''}" data-state="later" data-keys="${keyData}" aria-pressed="${reading === 'later'}">稍后读</button>
<button class="reading-button${reading === 'read' ? ' active' : ''}" data-state="read" data-keys="${keyData}" aria-pressed="${reading === 'read'}">已读</button>
<button class="check-link" data-key="${escapeHTML(item.key)}" data-status="${escapeHTML(status)}" title="在新的 X 标签页中检查原帖能否访问">${availability} ↻</button>
</div>
<div class="card-foot">
<span class="card-meta">${[...meta, posted, mediaLabel].map(part => `<span>${escapeHTML(part)}</span>`).join('')}</span>
<div><button class="tag-edit" data-key="${escapeHTML(item.key)}">整理</button><a href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer">原帖 ↗</a><button class="delete" data-key="${escapeHTML(item.key)}" title="从本地收藏库删除" aria-label="从收藏库删除此帖子">×</button></div>
</div></article>`;
}

function render() {
  const isPosts = ['all','bookmark','like','saved'].includes(view);
  $('#postsPanel').hidden = !isPosts;
  $('#peoplePanel').hidden = view !== 'people';
  $('#scanButton').hidden = !['all','bookmark','like'].includes(view);
  $('#title').textContent = titles[view];
  $('#subtitle').textContent = subtitles[view];
  $('#allCount').textContent = posts.length;
  $('#bookmarkCount').textContent = posts.filter(item => item.collection === 'bookmark').length;
  $('#likeCount').textContent = posts.filter(item => item.collection === 'like').length;
  $('#savedCount').textContent = posts.filter(item => item.collection === 'saved').length;
  $('#peopleCount').textContent = people.length;
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  if (!isPosts) return;

  const selectedAccount = $('#accountFilter').value;
  const accounts = [...new Set(posts.map(item => item.account || 'legacy'))].sort();
  $('#accountFilter').innerHTML = '<option value="all">所有账号</option>' + accounts.map(account => {
    const label = posts.find(item => item.account === account && item.accountName)?.accountName || account;
    return `<option value="${escapeHTML(account)}">@${escapeHTML(label)}</option>`;
  }).join('');
  $('#accountFilter').value = accounts.includes(selectedAccount) ? selectedAccount : 'all';

  const selectedAuthor = $('#authorFilter').value;
  const authorCounts = new Map();
  for (const item of posts) {
    if (!item.username) continue;
    const entry = authorCounts.get(item.username) || { count:0, name:item.author || item.username };
    entry.count++;
    authorCounts.set(item.username, entry);
  }
  const authors = [...authorCounts.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, 500);
  $('#authorFilter').innerHTML = '<option value="all">所有作者</option>' + authors.map(([username, entry]) =>
    `<option value="${escapeHTML(username)}">${escapeHTML(entry.name)} · ${entry.count}</option>`).join('');
  $('#authorFilter').value = authors.some(([username]) => username === selectedAuthor) ? selectedAuthor : 'all';

  renderTagBar();

  const parsed = parseQuery($('#search').value.trim());
  const terms = parsed.include.filter(term => term.length > 0);
  const filtered = sortPosts(filteredPosts(parsed));

  const groups = [];
  const grouped = new Map();
  for (const item of filtered) {
    const groupId = $('#collapseDuplicates').checked ? item.id : item.key;
    if (!grouped.has(groupId)) { const group = []; grouped.set(groupId, group); groups.push(group); }
    grouped.get(groupId).push(item);
  }

  const filterCount = activeFilterCount();
  $('#resultCount').textContent = (groups.length === filtered.length
    ? `${filtered.length.toLocaleString('zh-CN')} 条帖子`
    : `${filtered.length.toLocaleString('zh-CN')} 个保存项，合并为 ${groups.length.toLocaleString('zh-CN')} 张卡片`)
    + (filterCount ? `，已应用 ${filterCount} 个筛选` : '');
  $('#resetFilters').disabled = $('#resetFilters').hidden = filterCount === 0;
  const panelFilters = filterCount - ($('#search').value.trim() ? 1 : 0);
  $('#advancedToggle').textContent = `筛选${panelFilters ? ` · ${panelFilters}` : ''} ${$('#advancedPanel').hidden ? '▾' : '▴'}`;

  const layout = $('#layout').value;
  $('#cards').classList.toggle('list-layout', layout === 'list');
  $('#cards').classList.toggle('compact-layout', layout === 'compact');
  visibleKeys = filtered.map(item => item.key);
  updateSelection();

  $('#cards').innerHTML = groups.length
    ? groups.map(group => cardHTML(group, terms)).join('')
    : `<div class="empty"><span class="drawer-mark" aria-hidden="true"><i></i><i></i><i></i></span>
<h2>${filterCount ? '没有符合条件的帖子' : '还没有保存的帖子'}</h2>
<p>${filterCount
  ? '试试更改搜索词或筛选条件，或点击“重置筛选”。'
  : view === 'saved'
    ? '试试点击 X 帖子页面右下角的“✦ 保存到 X 抽屉”按钮。'
    : '登录 X 后，点击“＋ 从 X 导入”试试。'}</p></div>`;

  $('#cards').querySelectorAll('.post-select').forEach(input => {
    const keys = JSON.parse(input.dataset.keys);
    input.indeterminate = keys.some(key => selectedKeys.has(key)) && !keys.every(key => selectedKeys.has(key));
  });

  $('#history').innerHTML = [...history].reverse().slice(0,6).map(entry =>
    `<div class="history-row"><span>${escapeHTML(kindMarks[entry.collection] || entry.collection)}：确认 ${Number(entry.count) || 0} 条</span><time>${escapeHTML(new Date(entry.at).toLocaleString('zh-CN'))}</time></div>`
  ).join('') || '<p class="muted">还没有导入记录。</p>';
}

/* ── 확인 대화상자 ───────────────────────────── */
$('#confirmCancel').addEventListener('click', () => $('#confirmDialog').close('cancel'));
$('#confirmOk').addEventListener('click', () => $('#confirmDialog').close('ok'));
$('#confirmDialog').addEventListener('close', () => {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve($('#confirmDialog').returnValue === 'ok');
});
function confirmAction(title, text, okLabel) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel || '删除';
  $('#confirmDialog').returnValue = '';
  return new Promise(resolve => { confirmResolve = resolve; $('#confirmDialog').showModal(); });
}

/* ── 네비게이션·필터 연결 ────────────────────── */
document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; render(); }));

const filterControls = ['#search','#media','#sort','#accountFilter','#authorFilter','#readFilter','#linkFilter','#fromDate','#toDate','#layout','#collapseDuplicates','#untaggedOnly'];
for (const id of filterControls) {
  const control = $(id);
  if (!control) { console.warn(`未找到筛选控件 ${id}。`); continue; }
  control.addEventListener(id === '#search' ? 'input' : 'change', render);
}
for (const id of ['#fromDate','#toDate']) $(id).addEventListener('change', () => { $('#datePreset').value = $('#fromDate').value || $('#toDate').value ? 'custom' : 'all'; });

$('#datePreset').addEventListener('change', () => {
  const value = $('#datePreset').value;
  if (value === 'custom') { $('#advancedPanel').hidden = false; $('#advancedToggle').setAttribute('aria-expanded','true'); render(); return; }
  if (value === 'all') { $('#fromDate').value = ''; $('#toDate').value = ''; }
  else {
    const start = new Date();
    start.setDate(start.getDate() - Number(value));
    $('#fromDate').value = localDay(start.toISOString());
    $('#toDate').value = '';
  }
  render();
});

$('#advancedToggle').addEventListener('click', () => {
  const next = !$('#advancedPanel').hidden;
  $('#advancedPanel').hidden = next;
  $('#advancedToggle').setAttribute('aria-expanded', String(!next));
  render();
});

$('#resetFilters').addEventListener('click', () => {
  $('#search').value = '';
  for (const id of ['#media','#accountFilter','#authorFilter','#readFilter','#linkFilter']) $(id).value = 'all';
  $('#fromDate').value = $('#toDate').value = '';
  $('#datePreset').value = 'all';
  $('#untaggedOnly').checked = false;
  activeTags.clear();
  render();
});

$('#tagBar').addEventListener('click', event => {
  const button = event.target.closest('.tag-filter');
  if (!button) return;
  const tag = button.dataset.tag;
  if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
  render();
});

/* ── 선택·저장된 보기 ────────────────────────── */
$('#cards').addEventListener('change', event => {
  if (!event.target.matches('.post-select')) return;
  const keys = JSON.parse(event.target.dataset.keys);
  for (const key of keys) if (event.target.checked) selectedKeys.add(key); else selectedKeys.delete(key);
  event.target.closest('.card').classList.toggle('selected', event.target.checked);
  updateSelection();
});
$('#cards').addEventListener('error', event => {
  if (event.target.matches('.avatar-image')) event.target.replaceWith(document.createTextNode(event.target.dataset.initial || '?'));
}, true);
$('#selectVisible').addEventListener('change', event => {
  for (const key of visibleKeys) if (event.target.checked) selectedKeys.add(key); else selectedKeys.delete(key);
  render();
});
$('#clearSelection').addEventListener('click', () => { selectedKeys.clear(); render(); });

$('#saveView').addEventListener('click', () => { $('#viewName').value = ''; $('#viewDialog').showModal(); $('#viewName').focus(); });
$('#cancelView').addEventListener('click', () => $('#viewDialog').close());
$('#confirmView').addEventListener('click', async () => {
  const name = $('#viewName').value.trim().slice(0,50);
  if (!name) { $('#viewName').focus(); return; }
  if (savedViews.length >= 100) { notice('最多可以创建 100 个已保存视图。', true); return; }
  const entry = { id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`, name, settings:currentViewSettings() };
  await saveView(entry);
  await refreshSavedViews();
  $('#savedViewSelect').value = entry.id;
  $('#deleteView').disabled = false;
  $('#viewDialog').close();
  notice(`已保存视图「${name}」。`);
});
$('#savedViewSelect').addEventListener('change', () => {
  const entry = savedViews.find(item => item.id === $('#savedViewSelect').value);
  $('#deleteView').disabled = !entry;
  if (entry) applyViewSettings(entry.settings);
});
$('#deleteView').addEventListener('click', async () => {
  const id = $('#savedViewSelect').value;
  if (!id) return;
  await deleteView(id);
  await refreshSavedViews();
  notice('已删除保存的视图，帖子不受影响。');
});

/* ── 일괄 정리 ───────────────────────────────── */
function renderBulkTags() {
  $('#bulkTagChips').innerHTML = bulkTags.map((tag, index) => `<button type="button" class="tag-chip" data-index="${index}">#${escapeHTML(tag)} <span>×</span></button>`).join('');
}
function addBulkTags(value) {
  for (const part of String(value).split(/[,，\s]+/)) {
    const tag = part.trim().replace(/^#+/, '').slice(0,40);
    if (tag && bulkTags.length < 20 && !bulkTags.includes(tag)) bulkTags.push(tag);
  }
  renderBulkTags();
}
$('#bulkEdit').addEventListener('click', () => {
  bulkTags = []; renderBulkTags();
  $('#bulkTagInput').value = '';
  $('#bulkReading').value = 'keep';
  $('#bulkSummary').textContent = `为 ${selectedKeys.size} 个保存项添加标签或应用阅读状态。`;
  $('#bulkDialog').showModal();
});
$('#bulkTagInput').addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if ([' ', ',', 'Enter'].includes(event.key)) { event.preventDefault(); addBulkTags($('#bulkTagInput').value); $('#bulkTagInput').value = ''; }
});
$('#bulkTagInput').addEventListener('input', event => {
  if (event.isComposing || !/[,，\s]/.test($('#bulkTagInput').value)) return;
  const parts = $('#bulkTagInput').value.split(/[,，\s]+/);
  $('#bulkTagInput').value = parts.pop() || '';
  addBulkTags(parts.join(','));
});
$('#bulkTagChips').addEventListener('click', event => {
  const chip = event.target.closest('.tag-chip');
  if (!chip) return;
  bulkTags.splice(Number(chip.dataset.index), 1);
  renderBulkTags();
});
$('#cancelBulk').addEventListener('click', () => $('#bulkDialog').close());
$('#applyBulk').addEventListener('click', async () => {
  addBulkTags($('#bulkTagInput').value);
  $('#bulkTagInput').value = '';
  const state = $('#bulkReading').value;
  if (!bulkTags.length && state === 'keep') { $('#bulkDialog').close(); return; }
  const count = selectedKeys.size;
  await updateManyPosts([...selectedKeys], bulkTags, state);
  $('#bulkDialog').close();
  await refresh();
  notice(`已整理 ${count} 个保存项。`);
});

$('#deleteSelected').addEventListener('click', async () => {
  const keys = [...selectedKeys];
  if (!keys.length) return;
  const ok = await confirmAction('删除所选帖子', `将从此设备的收藏库中移除 ${keys.length} 个保存项。X 账号中的书签和喜欢不受影响。此操作无法撤销。`, `删除 ${keys.length} 项`);
  if (!ok) return;
  await deletePosts(keys);
  selectedKeys.clear();
  await refresh();
  notice(`已删除 ${keys.length} 个保存项。`);
});

/* ── 공유 ────────────────────────────────────── */
function selectedUniquePosts() {
  const unique = new Map();
  for (const item of posts.filter(post => selectedKeys.has(post.key))) if (!unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()];
}
function renderShare() {
  const items = selectedUniquePosts();
  $('#shareSummary').textContent = `${items.length} 条帖子${selectedKeys.size > items.length ? `，${selectedKeys.size - items.length} 个重复保存项只显示一次` : ''}`;
  const format = $('#shareFormat').value;
  const summary = item => (item.text || '无正文').replace(/\s+/g, ' ').trim().slice(0,160);
  $('#shareLinks').value = format === 'details'
    ? items.map(item => `${item.author || `@${item.username}`} (@${item.username})\n${summary(item)}\n${item.url}`).join('\n\n')
    : format === 'markdown'
      ? items.map(item => `- [${summary(item).slice(0,80)}](${item.url}) — @${item.username}`).join('\n')
      : items.map(item => item.url).join('\n');
  $('#shareFeedback').textContent = '';
}
$('#shareSelected').addEventListener('click', () => {
  if (!selectedKeys.size) return;
  renderShare();
  $('#shareDialog').showModal();
});
$('#shareFormat').addEventListener('change', renderShare);
$('#closeShare').addEventListener('click', () => $('#shareDialog').close());
$('#copyShare').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#shareLinks').value); $('#shareFeedback').textContent = '已复制到剪贴板。'; }
  catch { $('#shareLinks').focus(); $('#shareLinks').select(); $('#shareFeedback').textContent = '无法自动复制，已选中内容，请按 Ctrl+C 复制。'; }
});

/* ── 글 정리(태그·메모) ──────────────────────── */
function renderTagChips() {
  $('#tagChips').innerHTML = editingTags.map((tag, index) => `<button type="button" class="tag-chip" data-index="${index}" aria-label="删除标签 ${escapeHTML(tag)}">#${escapeHTML(tag)} <span>×</span></button>`).join('');
  renderTagSuggestions();
}
function renderTagSuggestions() {
  const counts = tagCounts();
  const suggestions = [...counts.keys()]
    .filter(name => !editingTags.includes(name))
    .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'zh-CN'))
    .slice(0, 12);
  $('#tagSuggest').innerHTML = suggestions.map(name => `<button type="button" data-tag="${escapeHTML(name)}">＋ ${escapeHTML(name)}</button>`).join('');
}
function addEditingTag(part) {
  const value = String(part).trim().replace(/^#+/, '').slice(0,40);
  if (value && editingTags.length < 20 && !editingTags.includes(value)) editingTags.push(value);
}
function commitTagInput() {
  for (const part of $('#tagInput').value.split(/[,，\s]+/)) addEditingTag(part);
  $('#tagInput').value = '';
  renderTagChips();
}
$('#tagInput').addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if ([' ', ',', 'Enter'].includes(event.key)) { event.preventDefault(); commitTagInput(); }
  if (event.key === 'Backspace' && !$('#tagInput').value && editingTags.length) { editingTags.pop(); renderTagChips(); }
});
$('#tagInput').addEventListener('input', event => {
  if (event.isComposing) return;
  if (/[,，\s]/.test($('#tagInput').value)) {
    const parts = $('#tagInput').value.split(/[,，\s]+/);
    $('#tagInput').value = parts.pop() || '';
    for (const part of parts) addEditingTag(part);
    renderTagChips();
  }
});
$('#tagChips').addEventListener('click', event => {
  const chip = event.target.closest('.tag-chip');
  if (!chip) return;
  editingTags.splice(Number(chip.dataset.index), 1);
  renderTagChips();
  $('#tagInput').focus();
});
$('#tagSuggest').addEventListener('click', event => {
  const button = event.target.closest('[data-tag]');
  if (!button) return;
  addEditingTag(button.dataset.tag);
  renderTagChips();
});
$('#tagDialog').addEventListener('close', async () => {
  if ($('#tagDialog').returnValue !== 'save' || !editingTagKey) return;
  commitTagInput();
  await updateOrganization(editingTagKey, editingTags, $('#noteInput').value.trim().slice(0,2000));
  editingTagKey = null;
  await refresh();
  notice('已保存备注和标签。');
});

/* ── 태그 관리 ───────────────────────────────── */
function renderTagManager() {
  const counts = tagCounts();
  const names = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'zh-CN'));
  $('#tagManagerList').innerHTML = names.length ? names.map(name => {
    const color = tagColor(name) || '#b07512';
    return `<div class="tag-manager-row" data-tag="${escapeHTML(name)}">
<input type="color" value="${escapeHTML(color)}" class="tag-color" aria-label="标签 ${escapeHTML(name)} 的颜色">
<input type="text" class="tag-rename" value="${escapeHTML(name)}" maxlength="40" aria-label="标签 ${escapeHTML(name)} 的名称">
<em>${counts.get(name)}</em>
<button type="button" class="ghost danger tag-remove">删除</button>
</div>`;
  }).join('') : '<p class="muted">还没有标签。</p>';
}
$('#manageTags').addEventListener('click', () => { renderTagManager(); $('#tagManagerDialog').showModal(); });
$('#closeTagManager').addEventListener('click', () => $('#tagManagerDialog').close());
$('#tagManagerList').addEventListener('change', async event => {
  const row = event.target.closest('.tag-manager-row');
  if (!row) return;
  const name = row.dataset.tag;
  try {
    if (event.target.matches('.tag-color')) {
      const color = safeColor(event.target.value);
      await putTagMeta({ name, color, createdAt:tagMeta.find(meta => meta.name === name)?.createdAt || new Date().toISOString() });
      await refresh();
      renderTagManager();
      return;
    }
    if (event.target.matches('.tag-rename')) {
      const next = event.target.value.trim().replace(/^#+/, '').slice(0,40);
      if (!next || next === name) { renderTagManager(); return; }
      await renameTagEverywhere(name, next);
      await refresh();
      renderTagManager();
      notice(`已将标签「${name}」重命名为「${next}」。`);
    }
  } catch (error) { notice(`修改标签失败：${error.message}`, true); }
});
$('#tagManagerList').addEventListener('click', async event => {
  const button = event.target.closest('.tag-remove');
  if (!button) return;
  const name = button.closest('.tag-manager-row').dataset.tag;
  const ok = await confirmAction('删除标签', `将从所有帖子上移除标签「${name}」，帖子本身不会被删除。`, '删除标签');
  if (!ok) return;
  try {
    await removeTagEverywhere(name);
    activeTags.delete(name);
    await refresh();
    renderTagManager();
    notice(`已删除标签「${name}」。`);
  } catch (error) { notice(`删除标签失败：${error.message}`, true); }
});

/* ── 원문 확인 ───────────────────────────────── */
async function checkOriginalPost(key, button) {
  const post = posts.find(item => item.key === key);
  if (!post) return;
  button.disabled = true;
  button.textContent = '正在检查原帖…';
  let tab;
  let status = 'unknown';
  try {
    tab = await chrome.tabs.create({ url:post.url, active:false });
    await waitForTabReady(tab.id);
    for (let attempt = 0; attempt < 5; attempt++) {
      let result;
      try { result = await chrome.tabs.sendMessage(tab.id, { type:'CHECK_POST', id:post.id }); }
      catch { /* 콘텐츠 스크립트가 아직 로드 중일 수 있다 */ }
      if (['available','unavailable'].includes(result?.status)) { status = result.status; break; }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    await updatePostFields(key, { linkStatus:status, checkedAt:new Date().toISOString() });
    await refresh();
    notice(status === 'available' ? '原帖目前可以查看。' : status === 'unavailable' ? 'X 页面显示无法访问原帖。无法确定具体原因（删除、设为私密或屏蔽等）。' : '无法判断原帖状态。请检查登录状态或页面加载情况后重试。', status !== 'available');
  } catch (error) {
    button.disabled = false;
    button.textContent = '无法确认 ↻';
    notice(`检查原帖时出错：${error.message}`, true);
  } finally { if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {}); }
}

$('#cards').addEventListener('click', async event => {
  const tagChip = event.target.closest('.card-tag');
  if (tagChip) {
    const tag = tagChip.dataset.tag;
    if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
    render();
    return;
  }
  const readingButton = event.target.closest('.reading-button');
  if (readingButton) {
    const keys = JSON.parse(readingButton.dataset.keys);
    const allActive = keys.every(key => posts.find(item => item.key === key)?.readingState === readingButton.dataset.state);
    await updateManyPosts(keys, [], allActive ? 'none' : readingButton.dataset.state);
    await refresh();
    return;
  }
  const checkButton = event.target.closest('.check-link');
  if (checkButton) { await checkOriginalPost(checkButton.dataset.key, checkButton); return; }
  const tagButton = event.target.closest('.tag-edit');
  if (tagButton) {
    editingTagKey = tagButton.dataset.key;
    const post = posts.find(item => item.key === editingTagKey);
    $('#tagPost').textContent = post?.text?.replace(/\s+/g, ' ').trim().slice(0,90) || post?.url || '';
    editingTags = [...(post?.tags || [])];
    $('#tagInput').value = '';
    renderTagChips();
    $('#noteInput').value = post?.note || '';
    $('#tagDialog').returnValue = '';
    $('#tagDialog').showModal();
    return;
  }
  const deleteButton = event.target.closest('.delete');
  if (!deleteButton) return;
  const target = posts.find(item => item.key === deleteButton.dataset.key);
  const ok = await confirmAction('删除帖子', `将从此设备的收藏库中移除此帖子。X 账号中的书签和喜欢不受影响。\n\n${(target?.text || target?.url || '').replace(/\s+/g, ' ').trim().slice(0,90)}`, '删除');
  if (!ok) return;
  await deletePost(deleteButton.dataset.key);
  await refresh();
  notice('已从本地收藏库删除。');
});

/* ── 가져오기(스캔) ──────────────────────────── */
$('#pauseScan').addEventListener('click', () => { scanPaused = true; $('#scanProgressText').textContent = '将在当前步骤后停止…'; });

/* "전체"는 빠른 탐색과 함께 쓸 수 없으므로 처음부터 탐색으로 고정한다. */
$('#rounds').addEventListener('change', () => {
  const readAll = $('#rounds').value === 'all';
  if (readAll) $('#scanMode').value = 'full';
  $('#scanMode').disabled = readAll;
  $('#readAllHint').hidden = !readAll;
});

/* X 요청 제한이 풀릴 때까지 기다린다. 중단을 누르면 바로 돌아온다. */
async function waitForRateLimit(retryAt, progress) {
  const until = Math.max(retryAt, Date.now()) + 5000;
  const resume = new Date(until).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' });
  $('#scanProgressText').textContent = `${progress}。已触发 X 请求限制，将在 ${resume} 自动继续，请勿关闭此页面`;
  while (Date.now() < until && !scanPaused) await new Promise(resolve => setTimeout(resolve, 1000));
}

async function runWebScan() {
  $('#scanButton').disabled = true;
  $('#scanProgress').hidden = false;
  scanPaused = false;
  const collection = $('#collection').value;
  const readAll = $('#rounds').value === 'all';
  const mode = readAll ? 'full' : $('#scanMode').value;
  const maxPages = readAll ? Infinity : Number($('#rounds').value) + 1;
  let pages = 0, newCount = 0, account = '', reason = '已达到设置的读取范围，可能还有更早的帖子。';
  const seen = new Set();
  const cursors = new Set();
  try {
    const session = await xSession();
    account = session.account;
    const accountName = await xAccountName(session);
    const known = new Set(posts.filter(post => post.account === account && post.collection === collection).map(post => post.id));
    let cursor = null, knownPages = 0, stalePages = 0;
    const progress = () => `${accountName ? `@${accountName}` : `账号 ${session.userId}`}：${pages} 页，确认 ${seen.size} 条，新帖 ${newCount} 条`;
    for (let page = 0; page < maxPages && !scanPaused; page++) {
      const currentSession = await xSession();
      if (currentSession.userId !== session.userId) throw new Error('同步期间 X 账号发生了变化。');
      let result = null;
      for (let attempt = 1; !result; attempt++) {
        try { result = await xReadPage(collection, session, cursor); }
        catch (error) {
          if (!readAll || !error.retryAt || attempt >= 5) throw error;
          await waitForRateLimit(error.retryAt, progress());
          if (scanPaused) break;
        }
      }
      if (!result) break;
      const items = result.items.map(item => normalizePost({ ...item, account, accountName:accountName || '', collection, key:`${account}:${collection}:${item.id}` }));
      let fresh = 0, unseen = 0;
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        unseen++;
        if (!known.has(item.id)) { newCount++; fresh++; }
      }
      if (items.length) await savePosts(account, collection, items, mode);
      pages++;
      $('#scanProgressText').textContent = progress();
      if (result.warnings.length) throw new Error(result.warnings.join('; '));
      knownPages = fresh ? 0 : knownPages + 1;
      stalePages = unseen ? 0 : stalePages + 1;
      if (!result.cursor || cursors.has(result.cursor)) { reason = '已检查到最后一页。'; break; }
      if (mode === 'incremental' && page >= 2 && knownPages >= 2) { reason = '连续出现已有帖子，已停止快速同步。'; break; }
      // 전체 읽기에는 페이지 상한이 없으므로, 끝에서 빈 페이지만 이어져도 멈추게 한다.
      if (readAll && stalePages >= 5) { reason = '连续 5 页没有新内容，已视为读到最后。'; break; }
      cursors.add(result.cursor);
      cursor = result.cursor;
      if (readAll) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await refresh();
    notice(`${accountName ? `@${accountName}` : `账号 ${session.userId}`}：在 ${pages} 页中确认 ${seen.size} 条，新帖 ${newCount} 条。${scanPaused ? '已保存到停止位置。' : reason}`, !seen.size);
  } catch (error) {
    await refresh();
    notice(`网页同步已中断：${error.message.replace(/。$/, '')}。${pages ? `已保存从 ${pages} 页读取的帖子。` : ''}`, true);
  } finally {
    $('#scanButton').disabled = false;
    $('#scanProgress').hidden = true;
  }
}

async function openScanDialog() {
  clearNotice();
  const tabs = await chrome.tabs.query({ currentWindow:true, url:['https://x.com/*','https://twitter.com/*'] });
  activeTab = tabs.filter(tab => collectionForURL(tab.url)).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
  $('#pageHint').textContent = activeTab ? `已打开的标签页：${activeTab.url}` : '将自动打开 X 页面并导入帖子。';
  if (activeTab) $('#collection').value = collectionForURL(activeTab.url);
  else if (['bookmark','like'].includes(view)) $('#collection').value = view;
  const profile = await profileFromTab(activeTab || tabs[0] || {});
  $('#accountHint').textContent = profile ? `登录账号：@${profile}` : '开始导入时将自动确认 X 登录账号。';
  $('#startScan').disabled = false;
  $('#scanDialog').returnValue = '';
  $('#scanDialog').showModal();
}
$('#scanButton').addEventListener('click', openScanDialog);

$('#scanDialog').addEventListener('close', async () => {
  if ($('#scanDialog').returnValue !== 'scan') return;
  if ($('#scanSource').value === 'web') { clearNotice(); await runWebScan(); return; }
  notice('正在从 X 标签页读取帖子，请勿关闭该标签页。');
  $('#scanButton').disabled = true;
  $('#scanProgress').hidden = false;
  scanPaused = false;
  const pending = new Map();
  let account, collection, mode;
  try {
    collection = $('#collection').value;
    if (!activeTab) {
      activeTab = await chrome.tabs.create({ url:'https://x.com/i/bookmarks', active:false });
      await waitForTabReady(activeTab.id);
    }
    account = await profileFromTab(activeTab);
    if (!account) throw new Error('无法确认 X 登录账号。请登录 X，刷新书签页面后重试。');
    if (collectionForURL(activeTab.url) !== collection) {
      const url = collection === 'bookmark' ? 'https://x.com/i/bookmarks' : `https://x.com/${account}/likes`;
      activeTab = await chrome.tabs.create({ url, active:false });
      await waitForTabReady(activeTab.id);
    }
    const before = await chrome.tabs.get(activeTab.id);
    if (collectionForURL(before.url) === 'like') {
      const pageAccount = /^\/([^/]+)\/likes\/?$/i.exec(new URL(before.url).pathname)?.[1]?.toLowerCase();
      if (pageAccount !== account) throw new Error('“喜欢”页面的账号与登录账号不一致。');
    }
    if (collectionForURL(before.url) !== collection) throw new Error('X 标签页的页面与所选收藏类型不一致。');
    const readAll = $('#rounds').value === 'all';
    mode = readAll ? 'full' : $('#scanMode').value;
    const maxRounds = readAll ? Infinity : Number($('#rounds').value);
    const known = new Set(posts.filter(item => item.account === account && item.collection === collection).map(item => item.id));
    const seen = new Set();
    let noNewRounds = 0, bottomRounds = 0, roundsDone = 0, newCount = 0;
    let stopReason = '已达到设置的读取范围，可能还有更早的帖子。';
    for (let round = 0; round <= maxRounds && !scanPaused; round++) {
      const response = await chrome.tabs.sendMessage(activeTab.id, { type:'SCAN_STEP', advance: round > 0 });
      if (!response?.ok) throw new Error(response?.error || '无法连接到 X 标签页，请刷新该标签页。');
      if (!response.profile || response.profile !== account) throw new Error('导入期间无法确认登录账号，或账号已发生变化。');
      const current = await chrome.tabs.get(activeTab.id);
      if (response.page !== before.url || current.url !== before.url) throw new Error('导入期间 X 标签页的地址发生了变化，请重试。');
      let freshThisRound = 0;
      for (const item of response.items) {
        const safe = normalizePost({ ...item, account, collection, key:`${account}:${collection}:${item.id}` });
        if (!seen.has(safe.id)) { seen.add(safe.id); freshThisRound++; if (!known.has(safe.id)) newCount++; }
        pending.set(safe.id, safe);
      }
      roundsDone = round + 1;
      noNewRounds = freshThisRound ? 0 : noNewRounds + 1;
      bottomRounds = response.bottom ? bottomRounds + 1 : 0;
      $('#scanProgressText').textContent = `第 ${roundsDone} 步，确认 ${seen.size} 条，新帖 ${newCount} 条`;
      if (pending.size >= 50 || round === maxRounds || noNewRounds >= 4 || bottomRounds >= 3) {
        if (pending.size) { await savePosts(account, collection, [...pending.values()], mode); pending.clear(); }
      }
      if (bottomRounds >= 3) { stopReason = '已检查到疑似页面末尾的位置。'; break; }
      if (mode === 'incremental' && round >= 3 && noNewRounds >= 2) { stopReason = '连续未发现新帖，已停止快速扫描。'; break; }
      if (noNewRounds >= 4) { stopReason = '连续未发现新帖，已停止。请检查是否有遗漏。'; break; }
    }
    if (pending.size) await savePosts(account, collection, [...pending.values()], mode);
    await refresh();
    notice(seen.size ? `@${account}：在 ${roundsDone} 步中确认 ${seen.size} 条，新帖 ${newCount} 条。${scanPaused ? '已保存到停止位置。' : stopReason}` : '没有导入任何帖子。请等 X 页面完全打开后重试。', !seen.size);
  } catch (error) {
    if (pending.size && account && collection) {
      try { await savePosts(account, collection, [...pending.values()], mode || 'partial'); await refresh(); }
      catch (saveError) { notice(`导入失败：${error.message}。最后一批数据也未能保存：${saveError.message}`, true); return; }
      notice(`导入已中断，但已保存最后 ${pending.size} 条帖子：${error.message}`, true);
    } else notice(`导入失败：${error.message}`, true);
  } finally {
    $('#scanButton').disabled = false;
    $('#scanProgress').hidden = true;
  }
});

/* ── 내보내기 / 가져오기 ─────────────────────── */
function downloadFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#exportButton').addEventListener('click', async () => {
  try {
    const payload = {
      format:'x-drawer-backup',
      version:6,
      exportedAt:new Date().toISOString(),
      posts,
      people:await getAll('people'),
      savedViews:await getAll('savedViews'),
      tags:await getAll('tags')
    };
    downloadFile(`x-drawer-${localDay(new Date().toISOString())}.json`, new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' }));
    notice(`已将 ${posts.length.toLocaleString('zh-CN')} 条帖子导出为 JSON 备份。`);
  } catch (error) { notice(`导出失败：${error.message}`, true); }
});

const CSV_COLUMNS = [
  ['键','key'], ['收藏类型','collectionLabel'], ['保存账号','account'], ['作者','author'], ['用户名','username'],
  ['帖子内容','text'], ['备注','note'], ['标签','tagList'], ['发布日期','date'], ['保存日期','savedAt'],
  ['喜欢数','likeCount'], ['浏览量','viewCount'], ['媒体','mediaLabel'], ['阅读状态','readingLabel'],
  ['原帖状态','linkLabel'], ['地址','url']
];
function csvCell(value) {
  let text = value == null ? '' : String(value);
  // 스프레드시트에서 수식으로 해석되지 않도록 앞에 작은따옴표를 붙인다.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
$('#exportCsvButton').addEventListener('click', () => {
  try {
    const parsed = parseQuery($('#search').value.trim());
    const rows = sortPosts(filteredPosts(parsed));
    const readingLabels = { later:'稍后阅读', read:'已读' };
    const linkLabels = { available:'可以查看', unavailable:'无法访问', unknown:'无法确认' };
    const body = rows.map(item => {
      const flat = {
        ...item,
        collectionLabel:kindLabels[item.collection] || item.collection,
        tagList:(item.tags || []).join(' '),
        mediaLabel:{ image:'图片', video:'视频' }[item.media] || '文本',
        readingLabel:readingLabels[item.readingState] || '未分类',
        linkLabel:linkLabels[item.linkStatus] || '未检查'
      };
      return CSV_COLUMNS.map(([, field]) => csvCell(flat[field])).join(',');
    });
    const csv = '﻿' + [CSV_COLUMNS.map(([label]) => csvCell(label)).join(','), ...body].join('\r\n');
    downloadFile(`x-drawer-${localDay(new Date().toISOString())}.csv`, new Blob([csv], { type:'text/csv;charset=utf-8' }));
    notice(`已将当前筛选条件下的 ${rows.length.toLocaleString('zh-CN')} 条帖子导出为 CSV。`);
  } catch (error) { notice(`CSV 导出失败：${error.message}`, true); }
});

$('#importButton').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('只能导入不超过 50MB 的备份文件。');
    const backup = JSON.parse(await file.text());
    if (backup.format !== 'x-drawer-backup' || ![1,2,3,4,5,6].includes(backup.version) || !Array.isArray(backup.posts)) throw new Error('不支持此备份格式。');
    if (backup.posts.length > 100000) throw new Error('一次最多只能导入 10 万条帖子。');
    const items = backup.posts.map(normalizePost);

    const people = backup.version >= 3 ? backup.people : [];
    if (!Array.isArray(people) || people.length > 50000) throw new Error('人物记录的格式或数量无效。');
    const validPeople = people.map(person => {
      const handle = String(person?.handle || '').toLowerCase();
      const match = String(person?.match || '').toLowerCase();
      if (!/^[a-z0-9_]{1,15}$/.test(handle) || (match && !/^[a-z0-9_]{1,15}$/.test(match))) throw new Error('人物记录中有无效的账号。');
      return { handle, match, label:String(person.label || '').slice(0,80), note:String(person.note || '').slice(0,500), privateAccount:!!person.privateAccount, updatedAt:String(person.updatedAt || '') };
    });

    const viewItems = backup.version >= 5 ? backup.savedViews : [];
    if (!Array.isArray(viewItems) || viewItems.length > 100) throw new Error('已保存视图的格式或数量无效。');
    const validViews = viewItems.map(entry => {
      if (typeof entry?.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 50 || !entry.settings || typeof entry.settings !== 'object') throw new Error('已保存视图中有无效的条目。');
      const settings = entry.settings;
      const text = key => typeof settings[key] === 'string' ? settings[key].slice(0,500) : '';
      const tags = Array.isArray(settings.tags)
        ? settings.tags.filter(tag => typeof tag === 'string').map(tag => tag.slice(0,40)).slice(0,20)
        : (typeof settings.tag === 'string' && settings.tag && settings.tag !== 'all' ? [settings.tag.slice(0,40)] : []);
      return { id:entry.id, name:entry.name.trim(), settings:{ view:text('view'), search:text('search'), media:text('media'), sort:text('sort'), account:text('account'), author:text('author'), tags, reading:text('reading'), link:text('link'), from:text('from'), to:text('to'), preset:text('preset'), layout:text('layout'), collapse:!!settings.collapse, untagged:!!settings.untagged } };
    });

    const tagItems = backup.version >= 6 ? backup.tags : [];
    if (!Array.isArray(tagItems) || tagItems.length > 5000) throw new Error('标签列表的格式或数量无效。');
    const validTags = tagItems.map(entry => {
      const name = typeof entry?.name === 'string' ? entry.name.trim().slice(0,40) : '';
      if (!name) throw new Error('标签列表中有无效的条目。');
      return { name, color:safeColor(entry.color), createdAt:typeof entry.createdAt === 'string' ? entry.createdAt.slice(0,30) : '' };
    });

    await importPosts(items);
    await withTransaction('people', 'readwrite', tx => {
      const peopleStore = tx.objectStore('people');
      for (const person of validPeople) {
        const request = peopleStore.get(person.handle);
        request.onsuccess = () => { if (!request.result) peopleStore.put(person); };
      }
    });
    const existingViews = new Set((await getAll('savedViews')).map(item => item.id));
    await withTransaction('savedViews', 'readwrite', tx => {
      const store = tx.objectStore('savedViews');
      for (const entry of validViews) if (!existingViews.has(entry.id)) { store.put(entry); existingViews.add(entry.id); }
    });
    await withTransaction('tags', 'readwrite', tx => {
      const store = tx.objectStore('tags');
      for (const entry of validTags) {
        const request = store.get(entry.name);
        request.onsuccess = () => { if (!request.result) store.put(entry); };
      }
    });

    await refresh();
    await refreshSavedViews();
    notice(`已导入 ${items.length} 条帖子、${validPeople.length} 条人物记录、${validViews.length} 个已保存视图和 ${validTags.length} 个标签。`);
  } catch (error) { notice(`文件导入失败：${error.message}`, true); }
  event.target.value = '';
});

/* ── 단축키 ──────────────────────────────────── */
document.addEventListener('keydown', event => {
  if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    $('#search').focus();
    return;
  }
  if (event.key === 'Escape' && document.activeElement === $('#search') && $('#search').value) {
    $('#search').value = '';
    render();
  }
});

/* ── 시작 ────────────────────────────────────── */
function applyStartupParams() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('view');
  if (['all','bookmark','like','saved','people'].includes(wanted)) view = wanted;
  const query = params.get('q');
  if (query) $('#search').value = query.slice(0,300);
  const tag = params.get('tag');
  if (tag) activeTags.add(tag.slice(0,40));
  return params.get('scan') === '1';
}

if (typeof XTheme !== 'undefined') XTheme.bind($('#themeToggle'));
const wantsScan = applyStartupParams();
Promise.all([refresh(), refreshSavedViews()])
  .then(() => { if (wantsScan && ['all','bookmark','like'].includes(view)) openScanDialog(); })
  .catch(error => notice(`打开收藏库失败：${error.message}`, true));
