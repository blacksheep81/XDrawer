// Read-only X web timeline client. Query IDs and feature flags follow the current X web protocol.
const X_WEB_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_OPERATIONS = {
  bookmark: { id:'iblrFnKr6PZUR-dWpfXG6g', name:'Bookmarks' },
  like: { id:'xA8fDIbrJfy4ojjjXmSR-A', name:'Likes' },
  user: { id:'RmmhHyIQp01b-lwA_zvAuw', name:'UsersByRestIds' }
};
let xWebFeatures;

async function xCookie(name) {
  return chrome.cookies.get({ url:'https://x.com/', name });
}

async function xSession() {
  const [auth, csrf, twid] = await Promise.all(['auth_token','ct0','twid'].map(xCookie));
  let decoded = twid?.value || '';
  try { decoded = decodeURIComponent(decoded); } catch {}
  const userId = /(?:^|\W)u=(\d+)/.exec(decoded)?.[1];
  if (!auth?.value || !csrf?.value || !userId) throw new Error('无法确认 X 登录信息。请登录 X 后刷新页面。');
  return { csrf:csrf.value, userId, account:`x${userId}` };
}

async function xFeatures() {
  if (!xWebFeatures) {
    const response = await fetch(chrome.runtime.getURL('x-web-features.json'));
    if (!response.ok) throw new Error('无法读取 X 请求配置。');
    xWebFeatures = await response.json();
  }
  return xWebFeatures;
}

async function xRequest(operation, variables, session) {
  const op = X_OPERATIONS[operation];
  const url = new URL(`https://x.com/i/api/graphql/${op.id}/${op.name}`);
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('features', JSON.stringify(await xFeatures()));
  if (operation === 'like') url.searchParams.set('fieldToggles', JSON.stringify({ withArticlePlainText:false }));
  const response = await fetch(url, {
    method:'GET', credentials:'include', cache:'no-store',
    headers: {
      authorization:`Bearer ${X_WEB_BEARER}`,
      'x-csrf-token':session.csrf,
      'x-twitter-active-user':'yes',
      'x-twitter-auth-type':'OAuth2Session',
      'x-twitter-client-language':'zh-cn'
    }
  });
  if (response.status === 401 || response.status === 403) throw new Error('X 登录会话已过期或请求被拒绝。');
  if (response.status === 429) {
    const error = new Error('已触发 X 请求限制，请稍后重试。');
    const reset = Number(response.headers.get('x-rate-limit-reset'));
    error.retryAt = reset ? reset * 1000 : Date.now() + 15 * 60000;
    throw error;
  }
  if (!response.ok) throw new Error(`X 网页请求失败（${response.status}）。请求格式可能已变更。`);
  return response.json();
}

function xUser(result) {
  const user = result?.rest_id || result?.core || result?.legacy ? result : result?.result;
  const legacy = user?.legacy || {};
  const core = user?.core || {};
  const username = core.screen_name || legacy.screen_name;
  return typeof username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(username) ? username.toLowerCase() : null;
}

async function xAccountName(session) {
  try {
    const data = await xRequest('user', { userIds:[session.userId] }, session);
    const users = data?.data?.users || [];
    for (const entry of users) {
      if (String(entry?.result?.rest_id || '') === session.userId) return xUser(entry);
    }
  } catch { /* Numeric account ID is enough to keep data separate. */ }
  try {
    const tabs = await chrome.tabs.query({ url:['https://x.com/*','https://twitter.com/*'] });
    for (const tab of tabs) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type:'PROFILE' });
        if (typeof response?.profile === 'string' && /^[a-z0-9_]{1,15}$/.test(response.profile)) return response.profile;
      } catch { /* Try the next X tab. */ }
    }
  } catch { /* A page is optional for bookmark syncing. */ }
  return null;
}

function xPost(result) {
  const tweet = result?.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  const id = String(tweet?.rest_id || tweet?.legacy?.id_str || '');
  const user = tweet?.core?.user_results?.result;
  const username = xUser(user);
  if (!/^\d+$/.test(id) || !username) return null;
  const legacy = tweet.legacy || {};
  const noteText = tweet?.note_tweet?.note_tweet_results?.result?.text;
  const media = legacy.extended_entities?.media || legacy.entities?.media || [];
  const imageUrls = media.filter(item => item?.type === 'photo').map(item => item.media_url_https).filter(Boolean);
  const hasVideo = media.some(item => item?.type === 'video' || item?.type === 'animated_gif');
  const links = (legacy.entities?.urls || []).map(item => item.expanded_url || item.url).filter(Boolean);
  const metric = value => { const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null; return Number.isSafeInteger(number) && number >= 0 ? number : null; };
  return {
    id, url:`https://x.com/${username}/status/${id}`, username,
    author:user?.core?.name || user?.legacy?.name || username,
    avatarUrl:user?.avatar?.image_url || user?.legacy?.profile_image_url_https || '',
    text:String(noteText || legacy.full_text || ''),
    date:legacy.created_at && !Number.isNaN(Date.parse(legacy.created_at)) ? new Date(legacy.created_at).toISOString() : '',
    media:hasVideo ? 'video' : imageUrls.length ? 'image' : 'text', imageUrls, links,
    likeCount:metric(legacy.favorite_count), viewCount:metric(tweet.views?.count ?? tweet.legacy?.view_count)
  };
}

function xTimeline(data, collection) {
  const timeline = collection === 'bookmark' ? data?.data?.bookmark_timeline_v2?.timeline : data?.data?.user?.result?.timeline?.timeline;
  if (!Array.isArray(timeline?.instructions)) throw new Error('未在 X 响应中找到帖子列表。网页请求格式可能已变更。');
  const entries = timeline.instructions.flatMap(part => part.entries || (part.entry ? [part.entry] : []));
  const found = new Map();
  let cursor = null;
  for (const entry of entries) {
    const content = entry?.content || {};
    if (content.cursorType === 'Bottom' && typeof content.value === 'string') cursor = content.value;
    const items = [content.itemContent, content.item?.itemContent, ...(content.items || []).map(item => item?.item?.itemContent || item?.itemContent)];
    for (const item of items) {
      const post = xPost(item?.tweet_results?.result);
      if (post) found.set(post.id, post);
    }
  }
  return { items:[...found.values()], cursor, warnings:(data.errors || []).map(error => String(error.message || error.code || 'X 响应错误')) };
}

async function xReadPage(collection, session, cursor = null) {
  const variables = collection === 'bookmark'
    ? { count:20, ...(cursor ? { cursor } : {}), includePromotedContent:true }
    : { userId:session.userId, count:20, ...(cursor ? { cursor } : {}), includePromotedContent:false, withClientEventToken:false, withBirdwatchNotes:false, withVoice:true };
  return xTimeline(await xRequest(collection, variables, session), collection);
}
