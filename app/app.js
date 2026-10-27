import {
  getAllFeeds, putFeed, deleteFeed, getMeta, setMeta, requestPersistence,
  getAllHistory, putHistory, deleteHistory, clearHistory,
} from './db.js';
import {
  loadCatalog, loadFeed, resolveSubscription, isLocalFeed, getCorsProxy, setCorsProxy,
} from './feeds.js';
import {
  createTile, resetThumbnails, setPlayListener,
} from './tiles.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const MAX_PARALLEL_REFRESHES = 4;
const MAX_HISTORY = 500;
const USER_CATEGORY = ['My Feeds'];

const headerSearch = document.getElementById('search');
const navLinks = document.querySelectorAll('header nav a');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');
const viewEl = document.getElementById('view');
const refreshButton = document.getElementById('refresh');
const settingsDialog = document.getElementById('settings-dialog');
const tabButtons = [...settingsDialog.querySelectorAll('[role="tab"]')];
const tabPanels = [...settingsDialog.querySelectorAll('[role="tabpanel"]')];
const customList = document.getElementById('custom-list');
const customEmpty = document.getElementById('custom-empty');
const proxyStatus = document.getElementById('proxy-status');
const urlForm = document.getElementById('url-form');
const urlInput = document.getElementById('url-input');
const urlStatus = document.getElementById('url-status');
const proxyInput = document.getElementById('proxy-input');
const catalogFilter = document.getElementById('catalog-filter');
const catalogStatus = document.getElementById('catalog-status');
const catalogList = document.getElementById('catalog-list');

// url -> { url, name, path, kind, items, fetchedAt, attemptedAt, error }
// kind is 'catalog', 'youtube' or 'rss'.
const subs = new Map();
let catalog = null;

// link -> { movie: { title, link, description }, watchedAt }; the movie is a
// copy, so history survives the feed it came from being removed or changing.
const history = new Map();

const normalize = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const categoryName = (path) => path.join(' / ') || 'Other';
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

function groupBy(list, keyOf) {
  const groups = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- subscriptions

function newSubscription({ url, name, path, kind, items = [] }) {
  return { url, name, path, kind, items, fetchedAt: 0, attemptedAt: 0, error: null };
}

// Persistence failures (e.g. quota) must not break the running session.
async function persist(sub) {
  try {
    await putFeed(sub);
  } catch (error) {
    console.warn('Could not store feed', sub.url, error);
  }
}

async function subscribe(sub) {
  subs.set(sub.url, sub);
  await persist(sub);
  syncCatalogButtons();
  renderCustomList();
}

async function unsubscribe(url) {
  subs.delete(url);
  try {
    await deleteFeed(url);
  } catch (error) {
    console.warn('Could not remove feed', url, error);
  }
  syncCatalogButtons();
  renderCustomList();
  render();
}

// Feeds from data/feeds are subscribed once on first sight; feeds the user
// removed are not brought back. Names and categories of catalog feeds follow
// the OPML.
async function installDefaults() {
  const seeded = new Set((await getMeta('seeded').catch(() => null)) ?? []);
  for (const feed of catalog) {
    const existing = subs.get(feed.url);
    if (existing) {
      if (existing.kind === 'catalog') {
        existing.name = feed.name;
        existing.path = feed.path;
        await persist(existing);
      }
      continue;
    }
    if (isLocalFeed(feed.url) && !seeded.has(feed.url)) {
      subs.set(feed.url, newSubscription({ ...feed, kind: 'catalog' }));
      await persist(subs.get(feed.url));
    }
  }
  catalog.filter((feed) => isLocalFeed(feed.url)).forEach((feed) => seeded.add(feed.url));
  await setMeta('seeded', [...seeded]).catch(() => {});
}

// ---------------------------------------------------------------- watch history

async function recordWatch(movie) {
  const entry = { link: movie.link, movie: { ...movie }, watchedAt: Date.now() };
  history.set(entry.link, entry);
  const stale = history.size > MAX_HISTORY
    ? [...history.values()].sort((a, b) => a.watchedAt - b.watchedAt).slice(0, history.size - MAX_HISTORY)
    : [];
  stale.forEach((old) => history.delete(old.link));
  try {
    await putHistory(entry);
    await Promise.all(stale.map((old) => deleteHistory(old.link)));
  } catch (error) {
    console.warn('Could not store watch history', error);
  }
}

// ---------------------------------------------------------------- refreshing

const inFlight = new Map();

const signature = (sub) => [
  sub.error, sub.fetchedAt > 0, sub.items.length, sub.items[0]?.link, sub.items.at(-1)?.link,
].join('|');

function refreshFeed(sub) {
  if (inFlight.has(sub.url)) return inFlight.get(sub.url);
  const task = (async () => {
    const before = signature(sub);
    sub.attemptedAt = Date.now();
    try {
      sub.items = (await loadFeed(sub.url)).items;
      sub.fetchedAt = Date.now();
      sub.error = null;
    } catch (error) {
      sub.error = error.message;
    }
    if (subs.get(sub.url) === sub) {
      await persist(sub);
      if (signature(sub) !== before) scheduleRender();
    }
  })().finally(() => inFlight.delete(sub.url));
  inFlight.set(sub.url, task);
  return task;
}

// Refreshes feeds not updated within a day (failed ones are retried hourly),
// or all feeds when forced.
async function refreshDue(force = false) {
  const now = Date.now();
  const queue = [...subs.values()].filter((sub) => force
    || (now - sub.fetchedAt > DAY_MS && now - sub.attemptedAt > RETRY_MS));
  const worker = async () => {
    while (queue.length) await refreshFeed(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_REFRESHES, queue.length) }, worker));
}

// ---------------------------------------------------------------- routing

const routeHref = (type, value) => `#/${type}/${encodeURIComponent(value)}`;

function parseRoute() {
  const [, type, value] = location.hash.split('/');
  if (type === 'all' || type === 'history') return { type };
  if ((type === 'feed' || type === 'category') && value) {
    return { type, value: decodeURIComponent(value) };
  }
  return { type: 'start' };
}

let lastRouteKey = null;
let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const route = parseRoute();
  const key = `${route.type}:${route.value ?? ''}`;
  if (key !== lastRouteKey) {
    headerSearch.value = '';
    window.scrollTo(0, 0);
    lastRouteKey = key;
  }
  resetThumbnails();
  statusEl.textContent = '';
  countEl.textContent = '';
  headerSearch.hidden = route.type === 'start';
  for (const link of navLinks) {
    if (link.dataset.route === route.type) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = 'RSSFlicks';

  const all = [...subs.values()];
  if (route.type === 'start') return renderStart(all);
  if (route.type === 'all') return renderFilms('All', all);
  if (route.type === 'history') return renderHistory();
  if (route.type === 'category') {
    return renderFilms(route.value, all.filter((sub) => categoryName(sub.path) === route.value));
  }
  const sub = subs.get(route.value);
  if (!sub) {
    viewEl.replaceChildren(backLink());
    statusEl.textContent = 'This feed is not installed.';
    return undefined;
  }
  return renderFilms(sub.name, [sub], sub);
}

// ---------------------------------------------------------------- start page

// A stable color per category: matte but vibrant, picked from a fixed palette
// so neighboring categories stay clearly distinguishable.
const CATEGORY_COLORS = [
  '#632723', '#6b3e20', '#655020', '#465422', '#235434', '#1a544e',
  '#204a5c', '#293d63', '#3a3263', '#502c5c', '#60294a', '#5c2c32',
];

// Starts at a slot derived from the name and moves on if another category on
// the page already uses it.
function categoryColor(name, used) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  let index = hash % CATEGORY_COLORS.length;
  if (used.size < CATEGORY_COLORS.length) {
    while (used.has(index)) index = (index + 1) % CATEGORY_COLORS.length;
  }
  used.add(index);
  return CATEGORY_COLORS[index];
}

function createCard(sub, color) {
  const card = el('article', 'card');
  card.style.setProperty('--card-color', color);

  const link = el('a', 'card-link', sub.name);
  link.href = routeHref('feed', sub.url);
  const title = el('h3', 'card-title');
  title.append(link);

  const count = sub.fetchedAt ? `${sub.items.length} ${sub.items.length === 1 ? 'film' : 'films'}` : '';
  const meta = el('p', 'card-meta', count);
  if (sub.error) {
    meta.textContent = `⚠ ${count}`.trim();
    meta.title = `Could not refresh: ${sub.error}`;
  }

  const remove = el('button', 'icon remove', '✕');
  remove.type = 'button';
  remove.title = 'Remove feed';
  remove.setAttribute('aria-label', `Remove ${sub.name}`);
  remove.addEventListener('click', () => {
    if (confirm(`Remove “${sub.name}”?`)) unsubscribe(sub.url);
  });

  card.append(title, meta, remove);
  return card;
}

// Points users at the catalog to subscribe to more feeds.
function createAddButton() {
  const button = el('button', 'add-feeds', '＋ Add');
  button.type = 'button';
  button.addEventListener('click', () => openSettings('subscriptions'));
  return button;
}

function renderStart(all) {
  if (!all.length) {
    const empty = el('div', 'empty');
    empty.append(el('p', '', 'No feeds installed yet.'), createAddButton());
    viewEl.replaceChildren(empty);
    return;
  }

  const groups = groupBy(all, (sub) => categoryName(sub.path));
  const sections = [];
  const usedColors = new Set();
  for (const name of [...groups.keys()].sort(byName)) {
    const section = el('section', 'category');
    const heading = el('h2');
    const link = el('a', '', name);
    link.href = routeHref('category', name);
    heading.append(link);
    const cards = el('div', 'cards');
    const color = categoryColor(name, usedColors);
    cards.append(...groups.get(name).sort((a, b) => byName(a.name, b.name)).map((sub) => createCard(sub, color)));
    section.append(heading, cards);
    sections.push(section);
  }
  const addRow = el('div', 'add-row');
  addRow.append(createAddButton());
  viewEl.replaceChildren(...sections, addRow);
}

// ---------------------------------------------------------------- film lists

function backLink() {
  const link = el('a', 'back', '←');
  link.href = '#/';
  return link;
}

let entries = [];

// Shows only tiles whose title or description contains every search term.
function applySearch() {
  const terms = normalize(headerSearch.value).split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const entry of entries) {
    entry.tile.hidden = !terms.every((term) => entry.text.includes(term));
    if (!entry.tile.hidden) visible++;
  }
  const filtered = terms.length > 0;
  countEl.textContent = filtered ? `${visible} of ${entries.length} films` : `${entries.length} films`;
  for (const group of viewEl.querySelectorAll('.history-group')) {
    group.hidden = !group.querySelector('.tile:not([hidden])');
  }
  statusEl.textContent = filtered && entries.length && !visible ? 'No films match your search.' : '';
}

function renderFilms(title, feedSubs, single) {
  document.title = `${title} – RSSFlicks`;
  const head = el('div', 'view-head');
  head.append(backLink(), el('h2', '', title));
  const children = [head];

  const failed = feedSubs.filter((sub) => sub.error);
  if (single?.error) {
    children.push(el('p', 'notice', `Could not refresh this feed: ${single.error}`));
  } else if (!single && failed.length) {
    children.push(el('p', 'notice', `${failed.length} feed(s) could not be refreshed.`));
  }

  const seen = new Set();
  const movies = feedSubs.flatMap((sub) => sub.items).filter((movie) => {
    const id = movie.link || movie.title;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  entries = movies.map((movie) => ({
    tile: createTile(movie),
    text: normalize(`${movie.title} ${movie.description}`),
  }));
  const tiles = el('div', 'tiles');
  tiles.append(...entries.map((entry) => entry.tile));
  children.push(tiles);
  viewEl.replaceChildren(...children);

  applySearch();
  if (!entries.length && !statusEl.textContent) {
    const loading = feedSubs.some((sub) => !sub.fetchedAt && !sub.error);
    statusEl.textContent = loading ? 'Loading…' : 'No films in this feed.';
  }
}

function dayLabel(timestamp) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday).setDate(new Date(startOfToday).getDate() - 1);
  if (timestamp >= startOfToday) return 'Today';
  if (timestamp >= startOfYesterday) return 'Yesterday';
  return 'Earlier';
}

function renderHistory() {
  document.title = 'Watch history – RSSFlicks';
  const head = el('div', 'view-head');
  head.append(backLink(), el('h2', '', 'Watch history'));
  if (history.size) {
    const clear = el('button', '', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', async () => {
      if (!confirm('Clear the whole watch history?')) return;
      history.clear();
      render();
      try {
        await clearHistory();
      } catch (error) {
        console.warn('Could not clear watch history', error);
      }
    });
    head.append(clear);
  }

  const watched = [...history.values()].sort((a, b) => b.watchedAt - a.watchedAt);
  const groups = new Map([['Today', []], ['Yesterday', []], ['Earlier', []]]);
  for (const item of watched) groups.get(dayLabel(item.watchedAt)).push(item);

  entries = [];
  const sections = [];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const groupEntries = items.map((item) => ({
      tile: createTile(item.movie),
      text: normalize(`${item.movie.title} ${item.movie.description ?? ''}`),
    }));
    entries.push(...groupEntries);
    const tiles = el('div', 'tiles');
    tiles.append(...groupEntries.map((entry) => entry.tile));
    const section = el('section', 'history-group');
    section.append(el('h3', '', label), tiles);
    sections.push(section);
  }
  viewEl.replaceChildren(head, ...sections);

  applySearch();
  if (!entries.length) statusEl.textContent = 'Nothing watched yet. Films you play show up here.';
}

headerSearch.addEventListener('input', applySearch);

// ---------------------------------------------------------------- add dialog

// An optional feed URL is appended to the message as a hyperlink.
function setFormStatus(node, message, isError = false, feedUrl = null) {
  node.textContent = message;
  if (feedUrl) {
    const link = el('a', '', feedUrl);
    link.href = feedUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    node.append(' ', link);
  }
  node.classList.toggle('error', isError);
}

function syncCatalogButtons() {
  for (const button of catalogList.querySelectorAll('button[data-url]')) {
    const subscribed = subs.has(button.dataset.url);
    button.textContent = subscribed ? 'Remove' : 'Add';
    button.classList.toggle('danger', subscribed);
  }
}

// Builds a tree that mirrors the OPML nesting. Items keep document order.
function buildCatalogTree(feeds) {
  const root = { items: [], categories: new Map() };
  for (const feed of feeds) {
    let node = root;
    for (const name of feed.path) {
      if (!node.categories.has(name)) {
        const child = { name, items: [], categories: new Map() };
        node.categories.set(name, child);
        node.items.push(child);
      }
      node = node.categories.get(name);
    }
    node.items.push(feed);
  }
  return root;
}

function createCatalogRow(feed) {
  const row = el('div', 'catalog-row');
  row.dataset.text = normalize(`${feed.path.join(' ')} ${feed.name}`);
  const button = el('button');
  button.type = 'button';
  button.dataset.url = feed.url;
  button.addEventListener('click', async () => {
    if (subs.has(feed.url)) {
      await unsubscribe(feed.url);
      return;
    }
    const sub = newSubscription({ ...feed, kind: 'catalog' });
    await subscribe(sub);
    scheduleRender();
    refreshFeed(sub);
  });
  row.append(el('span', '', feed.name), button);
  return row;
}

function createCatalogNodes(node) {
  return node.items.map((item) => {
    if (!item.items) return createCatalogRow(item);
    const group = el('details', 'catalog-group');
    group.open = true;
    const children = el('div', 'catalog-children');
    children.append(...createCatalogNodes(item));
    group.append(el('summary', '', item.name), children);
    return group;
  });
}

function buildCatalog() {
  catalogList.replaceChildren(...createCatalogNodes(buildCatalogTree(catalog)));
  syncCatalogButtons();
  filterCatalog();
}

// While filtering, sections containing matches are opened; the sections'
// previous open state is restored once the filter is cleared.
function filterCatalog() {
  const terms = normalize(catalogFilter.value).split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const row of catalogList.querySelectorAll('.catalog-row')) {
    row.hidden = !terms.every((term) => row.dataset.text.includes(term));
    if (!row.hidden) visible++;
  }
  for (const group of catalogList.querySelectorAll('.catalog-group')) {
    group.hidden = !group.querySelector('.catalog-row:not([hidden])');
    if (terms.length) {
      group.dataset.wasOpen ??= String(group.open);
      group.open = true;
    } else if (group.dataset.wasOpen !== undefined) {
      group.open = group.dataset.wasOpen === 'true';
      delete group.dataset.wasOpen;
    }
  }
  if (catalog) setFormStatus(catalogStatus, visible ? '' : 'No catalog feeds match.');
}

function renderCustomList() {
  const custom = [...subs.values()].filter((sub) => sub.kind !== 'catalog').sort((a, b) => byName(a.name, b.name));
  customEmpty.hidden = custom.length > 0;
  customList.replaceChildren(...custom.map((sub) => {
    const row = el('div', 'catalog-row');
    const label = el('span', '', sub.name);
    label.append(el('small', 'kind', sub.kind === 'youtube' ? 'YouTube' : 'RSS'));
    const remove = el('button', 'danger', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => unsubscribe(sub.url));
    row.append(label, remove);
    return row;
  }));
}

function selectTab(name) {
  for (const tab of tabButtons) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of tabPanels) panel.hidden = panel.dataset.panel !== name;
}

tabButtons.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = tabButtons[(index + step + tabButtons.length) % tabButtons.length];
    selectTab(next.dataset.tab);
    next.focus();
  });
});

async function openSettings(tab = 'subscriptions') {
  selectTab(tab);
  if (!settingsDialog.open) settingsDialog.showModal();
  if (tab === 'custom') urlInput.focus();
  renderCustomList();
  if (catalog && !catalogList.children.length) buildCatalog();
  if (!catalog) {
    setFormStatus(catalogStatus, 'Loading catalog…');
    try {
      catalog = await loadCatalog();
      setFormStatus(catalogStatus, '');
      buildCatalog();
    } catch (error) {
      setFormStatus(catalogStatus, `Could not load catalog: ${error.message}`, true);
    }
  }
}

urlForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = urlForm.querySelector('button');
  submit.disabled = true;
  setFormStatus(urlStatus, 'Looking up feed…');
  try {
    const found = await resolveSubscription(urlInput.value);
    const existing = subs.get(found.url);
    if (existing) {
      setFormStatus(urlStatus, `“${existing.name}” is already added:`, false, existing.url);
      return;
    }
    const now = Date.now();
    const sub = newSubscription({ ...found, path: USER_CATEGORY });
    Object.assign(sub, { fetchedAt: now, attemptedAt: now });
    await subscribe(sub);
    urlInput.value = '';
    setFormStatus(urlStatus, `Added “${sub.name}” (${sub.items.length} films):`, false, sub.url);
    scheduleRender();
  } catch (error) {
    setFormStatus(urlStatus, error.message, true);
  } finally {
    submit.disabled = false;
  }
});

proxyInput.value = getCorsProxy();
proxyInput.addEventListener('change', () => {
  setCorsProxy(proxyInput.value.trim());
  setFormStatus(proxyStatus, proxyInput.value.trim() ? 'Proxy saved.' : 'Proxy disabled.');
});
catalogFilter.addEventListener('input', filterCatalog);
document.getElementById('settings').addEventListener('click', () => openSettings());
document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = 'Refreshing…';
  try {
    await refreshDue(true);
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = 'Force Refresh';
    render();
  }
});

// ---------------------------------------------------------------- startup

async function init() {
  try {
    (await getAllFeeds()).forEach((sub) => subs.set(sub.url, sub));
  } catch (error) {
    statusEl.textContent = `Storage is unavailable: ${error.message}`;
    return;
  }
  try {
    catalog = await loadCatalog();
    await installDefaults();
  } catch (error) {
    catalog = null;
    console.warn('Could not install default feeds', error);
  }
  try {
    (await getAllHistory()).filter((entry) => entry.movie).forEach((entry) => history.set(entry.link, entry));
  } catch (error) {
    console.warn('Could not load watch history', error);
  }
  setPlayListener(recordWatch);
  requestPersistence();

  window.addEventListener('hashchange', render);
  render();

  // There is no background sync, so feeds are refreshed while the app is open
  // and when it becomes visible again.
  refreshDue();
  setInterval(refreshDue, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDue();
  });
}

init();
