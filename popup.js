const $ = selector => document.querySelector(selector);

/* 라이브러리 탭이 이미 열려 있으면 새로 만들지 않고 그 탭으로 이동한다. */
async function openLibrary(params) {
  const base = chrome.runtime.getURL('library.html');
  const query = new URLSearchParams(params || {}).toString();
  const target = query ? `${base}?${query}` : base;
  const tabs = await chrome.tabs.query({ url: `${base}*` });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, url: target });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: target });
  }
  window.close();
}

function relativeDay(iso) {
  const time = Date.parse(iso || '');
  if (Number.isNaN(time)) return '';
  const days = Math.floor((Date.now() - time) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

async function loadStats() {
  try {
    const posts = await getAll('posts');
    const count = collection => posts.filter(item => item.collection === collection).length;
    $('#popAll').textContent = posts.length.toLocaleString('zh-CN');
    $('#popBookmark').textContent = count('bookmark').toLocaleString('zh-CN');
    $('#popLike').textContent = count('like').toLocaleString('zh-CN');
    $('#popSaved').textContent = count('saved').toLocaleString('zh-CN');
    if (!posts.length) {
      $('#popLatest').textContent = '还没有保存的帖子。从导入开始吧。';
      return;
    }
    const newest = posts.reduce((best, item) => (Date.parse(item.savedAt || 0) > Date.parse(best.savedAt || 0) ? item : best));
    const when = relativeDay(newest.savedAt);
    const tags = new Set(posts.flatMap(item => item.tags || []));
    $('#popLatest').textContent = `最后保存：${when || '时间未知'}，共 ${tags.size} 个标签`;
  } catch (error) {
    $('#popLatest').textContent = `无法打开收藏库：${error.message}`;
    $('#popLatest').classList.add('error');
  }
}

$('#popSearchForm').addEventListener('submit', event => {
  event.preventDefault();
  const query = $('#popSearch').value.trim();
  openLibrary(query ? { q: query } : {});
});
$('#popStats').addEventListener('click', event => {
  const button = event.target.closest('[data-open]');
  if (button) openLibrary({ view: button.dataset.open });
});
$('#popOpen').addEventListener('click', () => openLibrary({}));
$('#popScan').addEventListener('click', () => openLibrary({ scan: '1' }));

loadStats();
