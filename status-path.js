function parseStatusPath(pathname) {
  const internal = /^\/i\/(?:web\/)?status\/(\d+)(?:\/|$)/.exec(pathname);
  if (internal) return { id:internal[1], username:null };
  const named = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/|$)/.exec(pathname);
  return named ? { id:named[2], username:named[1].toLowerCase() } : null;
}
