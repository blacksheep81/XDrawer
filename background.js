importScripts('status-path.js','db.js','xsync.js');

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'SAVE_VISIBLE_POST') return;
  (async () => {
    const tabURL = new URL(sender.tab?.url || '');
    const sourceId = parseStatusPath(tabURL.pathname)?.id;
    if (!['x.com','twitter.com'].includes(tabURL.hostname) || !sourceId) throw new Error('只能在 X 帖子页面保存。');
    const { id, username, author, avatarUrl, text, date, media, imageUrls, links } = message.post || {};
    if (id !== sourceId || !/^[A-Za-z0-9_]{1,15}$/.test(username || '')) throw new Error('当前 X 帖子与要保存的帖子不一致。');
    const { account } = await xSession();
    const accountName = typeof message.profile === 'string' && /^[a-z0-9_]{1,15}$/.test(message.profile) ? message.profile : '';
    const post = normalizePost({
      id, username:username.toLowerCase(), url:`https://x.com/${username}/status/${id}`, author, avatarUrl, text, date, media, imageUrls, links,
      account, accountName, collection:'saved', key:`${account}:saved:${id}`
    });
    await savePosts(account, 'saved', [post]);
    respond({ ok:true });
  })().catch(error => respond({ ok:false, error:error.message }));
  return true;
});
