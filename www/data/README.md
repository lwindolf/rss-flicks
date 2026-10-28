# Data

RSSFlicks is a client-side only app. All data comes from RSS feeds. Some feeds
are precompiled lists delivered with the app in `data/feeds` while others feeds
listed in `feeds.opml` are fetched on-demand.

`feeds.opml` is a catalog: users pick the feeds they want from it, or add
YouTube channels/playlists and RSS feed URLs themselves. Subscriptions and
their films are stored in the browser (IndexedDB) and refreshed once a day
while the app is open. Every catalog feed under `data/feeds` is subscribed on
first start (once; feeds the user removed are not re-added).

| Path | Description |
|------|-------------|
| `feeds/*.xml` | RSS 2.0 feeds, one item per film |
| `feeds.opml` | OPML catalog of available feeds; its nesting defines the categories |

## Precompiled Feeds

Each feed is human/agent generated. Check the feed channel source  origin:

- `title`: `Title (Year)`; the year is omitted if the source page does not give one
- `link` and `guid`: the film's video URL (identical)
- `description`: empty

| File | Source page | Included links |
|------|-------------|----------------|
| `feeds/film-noir.xml` | https://www.openculture.com/free_film_noir_movies | "Free" links (no "Buy" links) |
| `feeds/free-movies-online.xml` | https://www.openculture.com/freemoviesonline | "Free" links to `archive.org/details` and YouTube videos (`watch?v=`, `youtu.be`); no playlists or other hosts |
| `feeds/moviepilot-archive-org.xml` | https://www.moviepilot.de/liste/kostenlose-filme-bei-archiveorg-lorion42 | All list entries linking to `archive.org/details` (87); the film's German title and production year come from the list data |

No linked pages were followed when generating the feeds.

## OPML (`feeds.opml`)

OPML 2.0 feed catalog. The category structure is expressed by nesting `<outline>` elements:

- An outline **without** `xmlUrl` is a **category**. It may contain categories and feeds.
- An outline **with** `type="rss"` and `xmlUrl` is a **feed**. It is a leaf and belongs to the category it is nested in. The category path of a feed is the chain of its ancestors' `text` values, e.g. `Movies / Film Noir`.
- `xmlUrl` is a path relative to `feeds.opml` (e.g. `feeds/film-noir.xml`).
- `htmlUrl` is the source page the feed was built from.
- `text` is the display name; `title` repeats it for readers that expect it.

Current structure:

```
Movies
├── Film Noir
│   └── Free Film Noir Movies      feeds/film-noir.xml
└── Mixed Genres
    └── Free Movies Online         feeds/free-movies-online.xml
```
