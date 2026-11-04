importScripts('status-path.js','db.js','xsync.js');

function safeVisiblePost(post) {
  const id = String(post?.id || '');
  const username = String(post?.username || '');
  if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(username)) throw new Error('无法确认帖子地址。');
  const safeImage = value => { try { const url = new URL(value); return url.protocol === 'https:' && ['pbs.twimg.com','ton.twimg.com'].includes(url.hostname) ? url.href : ''; } catch { return ''; } };
  const safeLink = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };
  const imageUrls = Array.isArray(post.imageUrls) ? post.imageUrls.map(safeImage).filter(Boolean).slice(0,30) : [];
  const links = Array.isArray(post.links) ? post.links.map(safeLink).filter(Boolean).slice(0,30) : [];
  return { id, username:username.toLowerCase(), url:`https://x.com/${username}/status/${id}`, author:String(post.author || username).slice(0,100), text:String(post.text || '').slice(0,100000), avatarUrl:safeImage(post.avatarUrl), date:post.date && !Number.isNaN(Date.parse(post.date)) ? new Date(post.date).toISOString() : '', media:['text','image','video'].includes(post.media) ? post.media : 'text', imageUrls, links, readingState:'none', tags:[] };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'SAVE_VISIBLE_POST') return;
  (async () => {
    const tabURL = new URL(sender.tab?.url || '');
    const sourceId = parseStatusPath(tabURL.pathname)?.id;
    if (!['x.com','twitter.com'].includes(tabURL.hostname) || !sourceId) throw new Error('只能在 X 帖子页面保存。');
    const post = safeVisiblePost(message.post);
    if (post.id !== sourceId) throw new Error('当前 X 帖子与要保存的帖子不一致。');
    const session = await xSession();
    const profile = typeof message.profile === 'string' && /^[a-z0-9_]{1,15}$/.test(message.profile) ? message.profile : '';
    await savePosts(session.account, 'saved', [{ ...post, accountName:profile }], 'quick');
    respond({ ok:true });
  })().catch(error => respond({ ok:false, error:error.message }));
  return true;
});
