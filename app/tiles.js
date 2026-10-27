// Film tiles, thumbnails and the modal video player.

import { getThumbnailSrc } from './thumbnails.js';

const overlay = document.getElementById('player');
const playerTitle = document.getElementById('player-title');
const playerFrame = document.getElementById('player-frame');

const VIDEO_FILE = /\.(mp4|m4v|webm|ogv)$/i;

// Maps a movie URL to { type, id } for YouTube, archive.org or a direct video
// file (id is then the full URL); null otherwise.
export function identify(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (VIDEO_FILE.test(url.pathname)) return { type: 'video', id: url.href };
  const host = url.hostname.replace(/^www\./, '');
  let type = null;
  let id = null;
  if (host === 'youtube.com' && url.pathname === '/watch') {
    type = 'youtube';
    id = url.searchParams.get('v');
  } else if (host === 'youtu.be') {
    type = 'youtube';
    id = url.pathname.slice(1);
  } else if (host === 'archive.org' && url.pathname.startsWith('/details/')) {
    type = 'archive';
    id = url.pathname.split('/')[2];
  } else if (host === 'archive.org' && url.pathname === '/details.php') {
    type = 'archive';
    id = url.searchParams.get('identifier');
  }
  // The id ends up in iframe/img URLs, so only accept plain identifiers.
  return type && id && /^[\w.-]+$/.test(id) ? { type, id } : null;
}

function createPlayer({ type, id }, title) {
  if (type === 'video') {
    const video = document.createElement('video');
    video.src = id;
    video.title = title;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    return video;
  }
  const iframe = document.createElement('iframe');
  iframe.title = title;
  iframe.src = type === 'youtube'
    ? `https://www.youtube.com/embed/${id}?autoplay=1`
    : `https://archive.org/embed/${id}`;
  iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.setAttribute('frameborder', '0');
  return iframe;
}

let playListener = () => {};

// Called with the movie whenever the user starts playing one.
export function setPlayListener(listener) {
  playListener = listener;
}

function openPlayer(source, title) {
  playerTitle.textContent = title;
  playerFrame.replaceChildren(createPlayer(source, title));
  if (!overlay.open) overlay.showModal();
}

// Removing the iframe on close stops playback.
overlay.addEventListener('close', () => playerFrame.replaceChildren());
overlay.addEventListener('click', (event) => {
  if (event.target === overlay) overlay.close();
});
document.getElementById('player-close').addEventListener('click', () => overlay.close());

// Thumbnails are resolved (cache lookup or download) only once a tile scrolls
// near the viewport.
const thumbnailSources = new WeakMap();
const thumbnailObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbnailObserver.unobserve(entry.target);
    const { img, source } = thumbnailSources.get(entry.target);
    getThumbnailSrc(source).then((src) => { img.src = src; });
  }
}, { rootMargin: '200px' });

// Stops observing tiles that have been removed from the page.
export function resetThumbnails() {
  thumbnailObserver.disconnect();
}

export function createThumbnail(media, source) {
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => img.remove());
  thumbnailObserver.observe(media);
  thumbnailSources.set(media, { img, source });
  return img;
}

// Direct video files have no thumbnail service.
function createBlank() {
  const blank = document.createElement('div');
  blank.className = 'placeholder';
  return blank;
}

export function createTile(movie) {
  const tile = document.createElement('article');
  tile.className = 'tile';

  const media = document.createElement('div');
  media.className = 'media';

  const source = identify(movie.link);
  if (source) {
    media.append(source.type === 'video' ? createBlank() : createThumbnail(media, source));

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'play';
    play.setAttribute('aria-label', `Play ${movie.title}`);
    play.addEventListener('click', () => {
      openPlayer(source, movie.title);
      playListener(movie);
    });
    media.append(play);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.textContent = '🎞';
    media.append(placeholder);
  }

  const title = document.createElement('h2');
  title.className = 'title';
  title.textContent = movie.title;

  tile.append(media, title);
  return tile;
}
