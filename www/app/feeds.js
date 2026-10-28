// Fetching, parsing and resolving feeds (RSS, Atom, RDF, JSON Feed, YouTube).

import { FeedParser } from '../lib/lzone-feed-parser/src/parser.js';

export const OPML_URL = new URL('../data/feeds.opml', import.meta.url);
const LOCAL_FEEDS_URL = new URL('../data/feeds/', import.meta.url).href;

// Allow optional CORS proxy for cross-origin feed fetching.
const PROXY_KEY = 'rssflicks:corsProxy';

export function getCorsProxy() {
  try {
    return localStorage.getItem(PROXY_KEY);
  } catch {
    return null;
  }
}

export function setCorsProxy(value) {
  try {
    localStorage.setItem(PROXY_KEY, value);
  } catch {
    // localStorage unavailable: the proxy is not remembered.
  }
}

export const isLocalFeed = (url) => url.startsWith(LOCAL_FEEDS_URL);

async function fetchText(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    // A network-level failure of a cross-origin fetch is almost always CORS.
    const proxy = getCorsProxy();
    if (!proxy || new URL(url).origin === location.origin) {
      throw new Error(`${new URL(url).host} blocked the request (CORS) or is unreachable`);
    }
    response = await fetch(proxy + encodeURIComponent(url));
  }
  if (!response.ok) throw new Error(`${new URL(url).host}: HTTP ${response.status}`);
  return response.text();
}

// Returns catalog feeds as { name, path, url } where path is the chain of
// category names.
export function parseOpml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const body = doc.querySelector('opml > body');
  if (!body) throw new Error('invalid OPML');
  const feeds = [];
  const walk = (parent, path) => {
    for (const outline of parent.children) {
      if (outline.tagName !== 'outline') continue;
      const name = outline.getAttribute('text') || outline.getAttribute('title') || '';
      const xmlUrl = outline.getAttribute('xmlUrl');
      if (xmlUrl) {
        feeds.push({ name, path, url: new URL(xmlUrl, OPML_URL).href });
      } else {
        walk(outline, [...path, name]);
      }
    }
  };
  walk(body, []);
  return feeds;
}

export async function loadCatalog() {
  return parseOpml(await fetchText(OPML_URL));
}

const MAX_DESCRIPTION = 500;

function parseFeed(text) {
  const parser = FeedParser.parserAutoDiscover(text);
  if (!parser) return null;
  const feed = parser.parse(text);
  if (feed.error) throw new Error('invalid feed XML');
  return {
    title: (feed.title ?? '').trim(),
    items: feed.newItems.map((item) => ({
      title: (item.title ?? '').trim(),
      link: item.source ?? '',
      description: (item.description ?? '').replace(/<[^>]*>/g, ' ').slice(0, MAX_DESCRIPTION),
    })),
  };
}

// Resolves to { title, items }.
export async function loadFeed(url) {
  const feed = parseFeed(await fetchText(url));
  if (!feed) throw new Error('not a recognized feed');
  return feed;
}

const YOUTUBE_FEED = 'https://www.youtube.com/feeds/videos.xml';
const CHANNEL_ID = /^UC[\w-]{22}$/;
const PLAYLIST_ID = /^(PL|UU|FL|OLAK5uy_)[\w-]{10,}$/;

function youtubeFeedUrl(param, id) {
  return `${YOUTUBE_FEED}?${param}=${encodeURIComponent(id)}`;
}

async function resolveYoutube(url) {
  const list = url.searchParams.get('list');
  if (list) return youtubeFeedUrl('playlist_id', list);

  const [kind, value] = url.pathname.split('/').filter(Boolean);
  if (kind === 'channel' && CHANNEL_ID.test(value ?? '')) {
    return youtubeFeedUrl('channel_id', value);
  }
  if (kind === 'feeds') return url.href;
  if (url.pathname === '/watch') {
    throw new Error('That is a single video; use a channel or playlist URL.');
  }

  // @handle, /user/… and /c/… pages name the channel only in their HTML.
  let html;
  try {
    html = await fetchText(url.href);
  } catch {
    throw new Error('Cannot look up this Youtube channel/playlist!');
  }
  const [rss] = FeedParser.linkAutoDiscover(html, url.href).filter((link) => link.startsWith(YOUTUBE_FEED));
  if (rss) return rss;
  const id = /"(?:channelId|externalId)":"(UC[\w-]{22})"/.exec(html)?.[1];
  if (id) return youtubeFeedUrl('channel_id', id);
  throw new Error('Could not find a channel at this URL.');
}

function toUrl(input) {
  if (CHANNEL_ID.test(input)) return { youtube: youtubeFeedUrl('channel_id', input) };
  if (PLAYLIST_ID.test(input)) return { youtube: youtubeFeedUrl('playlist_id', input) };
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url;
  try {
    if (/\s/.test(input)) throw new Error('whitespace');
    url = new URL(withScheme);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are supported.');
  return { url };
}

// Turns what the user typed (YouTube channel/playlist URL or ID, feed URL or
// web page URL) into a verified subscription: { url, kind, name, items }.
export async function resolveSubscription(input) {
  input = input.trim();
  if (!input) throw new Error('Enter a URL.');

  const { url, youtube } = toUrl(input);
  let feedUrl = youtube;
  let kind = youtube ? 'youtube' : 'rss';
  if (!feedUrl) {
    if (/^(www\.|m\.|music\.)?youtube\.com$/.test(url.hostname)) {
      feedUrl = await resolveYoutube(url);
      kind = 'youtube';
    } else if (url.hostname === 'youtu.be') {
      throw new Error('That is a single video; use a channel or playlist URL.');
    } else {
      feedUrl = url.href;
    }
  }

  let text = await fetchText(feedUrl);
  let feed = parseFeed(text);
  if (!feed && kind === 'rss') {
    // Not a feed: treat it as a web page and follow its advertised feed.
    const [discovered] = FeedParser.linkAutoDiscover(text, feedUrl);
    if (!discovered) throw new Error('No feed found at this URL.');
    feedUrl = discovered;
    text = await fetchText(feedUrl);
    feed = parseFeed(text);
  }
  if (!feed) throw new Error('No feed found at this URL.');

  return {
    url: feedUrl,
    kind,
    name: feed.title || new URL(feedUrl).host,
    items: feed.items,
  };
}
