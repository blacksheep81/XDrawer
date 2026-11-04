const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function currentProfile() {
  const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') || '';
  return /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(href)?.[1]?.toLowerCase() || null;
}
function extractArticle(article) {
    const anchors = [...article.querySelectorAll('a[href*="/status/"]')].filter(anchor => anchor.closest('article[data-testid="tweet"]') === article && !anchor.closest('[data-testid="quoteTweet"],[data-testid="tweetText"]'));
    const candidates = anchors.map(anchor => {
      try {
        const url = new URL(anchor.getAttribute('href'), location.href);
        if (!['x.com','twitter.com'].includes(url.hostname)) return null;
        const status = parseStatusPath(url.pathname);
        return status ? { anchor, status } : null;
      } catch { return null; }
    }).filter(Boolean);
    const chosen = candidates.find(item => item.anchor.querySelector('time')) || candidates.find(item => item.status.username) || candidates[0];
    if (!chosen) return null;
    const profileHref = article.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href') || '';
    const profileName = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(profileHref)?.[1];
    const username = chosen.status.username || profileName?.toLowerCase();
    if (!username) return null;
    const id = chosen.status.id;
    const text = article.querySelector('[data-testid="tweetText"]')?.innerText || '';
    const userBlock = article.querySelector('[data-testid="User-Name"]');
    const author = userBlock?.innerText?.split('\n')[0] || username;
    const avatarUrl = article.querySelector('[data-testid="Tweet-User-Avatar"] img')?.src || '';
    const time = article.querySelector('time')?.getAttribute('datetime') || null;
    const imageUrls = [...article.querySelectorAll('a[href*="/photo/"] img')].map(x => x.src).filter(Boolean);
    const links = [...article.querySelectorAll('[data-testid="tweetText"] a[href]')].map(a => a.href).filter(Boolean);
    const hasVideo = !!article.querySelector('video,[data-testid="videoPlayer"]');
    const hasImage = imageUrls.length > 0 || !!article.querySelector('[data-testid="tweetPhoto"]');
    return { id, url: `https://x.com/${username}/status/${id}`, username, author, avatarUrl, text, date: time, imageUrls: [...new Set(imageUrls)], links: [...new Set(links)], media: hasVideo ? 'video' : hasImage ? 'image' : 'text' };
}
/* 타임라인에 끼어든 광고 글. 광고 표시가 있는 글은 북마크나 좋아요가 아니므로 읽지 않는다. */
function isPromoted(article) {
  if (article.closest('[data-testid="placementTracking"]')) return true;
  return [...article.querySelectorAll('span')].some(span => /^(?:Ad|Promoted|广告|推广|廣告|已推广|프로모션|광고)$/.test(span.textContent.trim()));
}
function extract() {
  const found = new Map();
  for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
    if (isPromoted(article)) continue;
    const post = extractArticle(article);
    if (post) found.set(post.id, post);
  }
  return [...found.values()];
}
let quickSaveButton;
function detailPost() {
  const id = parseStatusPath(location.pathname)?.id;
  return id ? [...document.querySelectorAll('article[data-testid="tweet"]')].map(extractArticle).find(post => post?.id === id) : null;
}
function updateQuickSave() {
  const post = detailPost();
  if (!quickSaveButton && post) {
    quickSaveButton = document.createElement('button');
    quickSaveButton.type = 'button';
    quickSaveButton.textContent = '✦ 保存到 X 抽屉';
    quickSaveButton.setAttribute('aria-label','将当前 X 帖子手动保存到 X 抽屉');
    quickSaveButton.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;border:1px solid #4a6f65;border-radius:4px;padding:12px 16px;background:#2c4a43;color:#f2f5f0;font:600 13px system-ui,sans-serif;box-shadow:0 12px 30px #0008;cursor:pointer';
    quickSaveButton.addEventListener('click', async () => {
      const current = detailPost();
      if (!current) { quickSaveButton.textContent = '未找到帖子'; return; }
      quickSaveButton.disabled = true;
      quickSaveButton.textContent = '正在保存…';
      try {
        const result = await chrome.runtime.sendMessage({ type:'SAVE_VISIBLE_POST', post:current, profile:currentProfile() });
        quickSaveButton.textContent = result?.ok ? '✓ 已保存到抽屉' : `保存失败：${result?.error || '请重试'}`;
      } catch { quickSaveButton.textContent = '保存失败 · 请重试'; }
      finally { quickSaveButton.disabled = false; }
    });
    document.body.appendChild(quickSaveButton);
  }
  if (quickSaveButton) {
    quickSaveButton.hidden = !post;
    if (post && !quickSaveButton.disabled && quickSaveButton.dataset.postId !== post.id) {
      quickSaveButton.dataset.postId = post.id;
      quickSaveButton.textContent = '✦ 保存到 X 抽屉';
    }
  }
}
if (document.body) {
  updateQuickSave();
  let updateQueued = false;
  new MutationObserver(() => {
    if (updateQueued) return;
    updateQueued = true;
    setTimeout(() => { updateQueued = false; updateQuickSave(); }, 250);
  }).observe(document.body, { childList:true, subtree:true });
  window.addEventListener('popstate', updateQuickSave);
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === 'PROFILE') {
    respond({ profile:currentProfile() });
    return;
  }
  if (message.type !== 'SCAN_STEP') return;
  (async () => {
    const page = location.href;
    if (message.advance) {
      window.scrollBy(0, Math.max(500, innerHeight * .8));
      await wait(1100);
    }
    if (location.href !== page) throw new Error('X 页面已发生变化。');
    const items = extract();
    const bottom = window.scrollY + innerHeight >= document.documentElement.scrollHeight - 100;
    const profile = currentProfile();
    respond({ ok: true, items, page, bottom, position: window.scrollY, profile });
  })().catch(error => respond({ ok: false, error: String(error) }));
  return true;
});
