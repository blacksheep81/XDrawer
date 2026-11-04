# X Drawer (X 抽屉)

[中文](README.md) · **English**

X Drawer is a Chrome extension that keeps your X (Twitter) bookmarks, likes and manually saved posts in a local library inside your browser, where you can search, categorize and organize them. The interface is in Chinese.

- All data stays in this browser's IndexedDB and never goes through a server
- Saved text stays readable even after the original post is deleted or becomes unavailable
- It never changes posts, bookmarks or likes on your X account

## Features

**Importing and saving**
- **Import from X:** reads the bookmarks or likes of the signed-in account, either through X web sync (recommended) or by scrolling the page (fallback). You can scan only new posts or read all the way to the end. When X rate-limits requests, the import waits and resumes on its own.
- **Manual save:** click **✦ 保存到 X 抽屉** at the bottom right of any X post page.
- Works with several X accounts, and the sidebar can group posts by the account that saved them.

**Search and filters**
- Full-text search covers post text, notes, authors, links and tags, with this syntax:

  | Syntax | Meaning |
  |---|---|
  | `"design system"` | Exact phrase |
  | `-ads` | Exclude a keyword |
  | `from:handle` / `-from:handle` | Include or exclude an author |
  | `tag:name` / `-tag:name` | Include or exclude a tag |
  | `has:image` `has:video` `has:media` `has:link` `has:note` `has:tag` | Filter by content; prefix with `-` to exclude |
  | `is:read` `is:unread` `is:later` | Filter by reading state |

- You can filter by type, account, author, reading state and date, and save the filters you use often as views.
- There are card, list and compact layouts, and copies of the same post saved in several places can be merged into one card. Long posts can be expanded in place (展开全文).

**Organizing**
- Posts can have tags (up to 20 each), notes and a read-later or read state, and you can organize many posts at once.
- The 整理 group in the sidebar gives two shortcuts:
  - **待整理 (to organize):** posts with no tags that are not in any smart category
  - **稍后读 (read later):** posts marked to read later
- **Smart categories** sort posts automatically. A category can match any or all of its keywords, exclude terms, limit to certain authors, and use extra conditions such as `has:image -has:link -from:someone`. Posts imported later are sorted in too.
  - A category can add a tag automatically, and you can tag the posts you already have in one batch and undo it.
  - The current search can be saved as a smart category. Conditions that depend on things you change yourself, such as `tag:` and `is:`, are left out, and the dialog says which ones.
- **Move to category (移到分类):** select posts and click 移到分类 in the bottom bar to put them into an existing category or a new one. When you are viewing a category, the posts also leave that category. Posts added by hand stay in the category whatever its keywords are, and a move can be undone.
- **People (人物·小号):** add aliases and notes to other people's accounts so you can recognize them.
- You can share the posts you select as links, as text with links, or as a Markdown list.

**Backup**
- The 备份与导出 (backup and export) menu has three options:
  - **Export a JSON backup:** includes tags, notes and smart categories
  - **Export CSV:** the posts in the current filter
  - **Import a backup:** posts that already exist are merged
- The interface follows your system's light or dark setting.

## Installation

1. Download or clone this repository:
   ```bash
   git clone https://github.com/blacksheep81/XDrawer.git
   ```
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder.
4. Sign in to [x.com](https://x.com), click the X Drawer icon in the toolbar, then click **从 X 导入** (import from X).

The `key` in `manifest.json` pins the extension ID to `cfpjibdhkfnibjiigeiebdmmodmkclcd`, so the ID is the same on every computer.

## Privacy and permissions

| Permission | Used for |
|---|---|
| `cookies` | Reads your x.com sign-in state so it can call the X web API with your current session. Cookies and tokens are never written to the library. |
| `tabs` | Opens the library page and drives the X tab during scroll import. |
| `storage` | Declared in the manifest but not used by the current code. The theme simply follows your system setting. |
| `x.com` / `twitter.com` | Shows the save button on post pages and reads bookmarks and likes. |

Your library lives only inside this extension in this browser. Uninstalling the extension or clearing its data deletes the library, so export a JSON backup now and then.

## Project layout

| File | Purpose |
|---|---|
| `manifest.json` | Extension config (Manifest V3) |
| `background.js` | Background script that handles manual saves |
| `capture.js`, `status-path.js` | Injected into X pages: save button, scroll import |
| `xsync.js`, `x-web-features.json` | X web sync (read-only) |
| `db.js` | IndexedDB storage, smart categories and auto-tag rules |
| `library.html`, `library.js`, `style.css` | The main library page |
| `people.js` | People (人物·小号) |
| `popup.html`, `popup.js`, `popup.css` | Toolbar popup |
| `theme.js`, `tokens.css` | Theme and design tokens |

There is no build step. After changing the code, click the reload button on the extension's card in `chrome://extensions`.

## Notes

- Import skips the ads X inserts into timelines, so only posts you actually bookmarked or liked are saved. Posts you later unbookmark or unlike on X are not removed from the library automatically.
- X web sync relies on X's internal web API. If an X update breaks it for a while, use scroll import instead.
- This project is not affiliated with X Corp.

## License

[MIT](LICENSE)
