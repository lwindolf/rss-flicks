// Thumbnail cache in localStorage.
//
// The original JPEG bytes are stored unchanged as data URLs (no canvas
// re-encoding, which some browsers and privacy extensions corrupt). The small
// 320x180 YouTube variant keeps hundreds of thumbnails within the ~5 MB
// localStorage quota. Reading the image bytes needs CORS, which only
// i.ytimg.com allows; archive.org thumbnails are used directly and are left to
// the browser's HTTP cache.

const KEY_PREFIX = 'rssflicks:thumb:';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function thumbnailUrl({ type, id }) {
  return type === 'youtube'
    ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
    : `http://archive.org/services/img/${id}`;
}

const isCacheable = ({ type }) => type === 'youtube';

function readCache(key) {
  try {
    const entry = JSON.parse(localStorage.getItem(key));
    if (entry && typeof entry.d === 'string' && Date.now() - entry.t < MAX_AGE_MS) {
      return entry.d;
    }
    localStorage.removeItem(key);
  } catch {
    // Unreadable entry or storage unavailable: treat as a cache miss.
  }
  return null;
}

// Drops the oldest quarter of all cached thumbnails.
function evictOldest() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith(KEY_PREFIX)) continue;
    let t = 0;
    try {
      t = JSON.parse(localStorage.getItem(key)).t || 0;
    } catch {
      // Corrupt entries sort first and get evicted.
    }
    entries.push({ key, t });
  }
  entries.sort((a, b) => a.t - b.t);
  entries.slice(0, Math.max(1, Math.ceil(entries.length / 4)))
    .forEach(({ key }) => localStorage.removeItem(key));
}

function writeCache(key, dataUrl) {
  const value = JSON.stringify({ t: Date.now(), d: dataUrl });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      localStorage.setItem(key, value);
      return;
    } catch {
      evictOldest();
    }
  }
}

function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Resolves to a URL usable as <img src>: a cached data URL, a freshly cached
// one, or the original URL if the image cannot be cached.
export async function getThumbnailSrc(source) {
  const url = thumbnailUrl(source);
  if (!isCacheable(source)) return url;

  const key = KEY_PREFIX + source.type + ':' + source.id;
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return url;
    const blob = await response.blob();
    if (blob.type !== 'image/jpeg') return url;
    const dataUrl = await toDataUrl(blob);
    writeCache(key, dataUrl);
    return dataUrl;
  } catch {
    return url;
  }
}
