# Jukebox - Live Song Request App

## Overview
Web app that lets audience members request songs for a live musician. Two views: audience request page and musician dashboard. Designed for nightly residence performances.

## Tech Stack
- **Backend**: Node.js with Express
- **Database**: SQLite via better-sqlite3
- **Frontend**: Server-rendered HTML with vanilla JS (no framework, no build tools)
- **Real-time**: Polling every 5 seconds

## Data Model

### Sessions
Each performance night is a session.
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,        -- short random code (e.g., "ABC123")
  name TEXT,                  -- optional label ("Monday Jazz Night")
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  active INTEGER DEFAULT 1   -- 1 = accepting requests, 0 = closed
);
```

### Requests
```sql
CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  song TEXT NOT NULL,
  artist TEXT,                -- optional
  requester_id TEXT,          -- anonymous session cookie
  status TEXT DEFAULT 'queued',  -- queued | playing | played | skipped
  votes INTEGER DEFAULT 1,
  position INTEGER,           -- manual ordering by musician
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  played_at DATETIME,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

### Votes (prevent double-voting)
```sql
CREATE TABLE votes (
  request_id INTEGER,
  voter_id TEXT,              -- anonymous session cookie
  PRIMARY KEY (request_id, voter_id),
  FOREIGN KEY (request_id) REFERENCES requests(id)
);
```

## API Endpoints

### Session Management
- `POST /api/sessions` - Create new session. Returns `{ id, name }`. Protected by musician PIN.
- `GET /api/sessions/:id` - Get session info (name, active status, request count)
- `PATCH /api/sessions/:id` - Update session (close/reopen). Protected.

### Requests
- `GET /api/sessions/:id/requests` - List all requests for session. Returns sorted by: status (playing first, then queued sorted by votes desc, then played/skipped).
- `POST /api/sessions/:id/requests` - Submit a request. Body: `{ song, artist? }`. Sets requester_id from cookie. Returns the created request. Rejects duplicates (same song+artist in same session, case-insensitive).
- `POST /api/requests/:id/vote` - Upvote a request. One vote per voter_id per request. Increments vote count.
- `PATCH /api/requests/:id` - Update request status. Protected. Body: `{ status }` where status is playing/played/skipped.
- `DELETE /api/requests/:id` - Remove a request. Protected.

### Auth
- Musician sets a PIN when creating a session (stored hashed in memory, not DB)
- Protected endpoints require `X-Pin: <pin>` header
- Audience is anonymous, identified by a random cookie (`jukebox_id`)

## Routes / Views

### `GET /` - Landing Page
- Simple page: "Enter session code" input field
- Or scan QR code (which encodes the full URL)
- Redirects to `/s/:id`

### `GET /s/:id` - Audience Request Page
- Header: session name + "Now Playing" (if any song has status=playing)
- Request form: song name (required), artist (optional), submit button
- Current queue: list of queued songs with vote counts
- Each song has an upvote button (disabled if already voted, based on cookie)
- Played songs shown in a collapsed "Already Played" section at bottom
- Auto-refreshes queue every 5 seconds via fetch
- If session is closed: show "Requests are closed" message, hide form

### `GET /dj` - Musician Dashboard
- "Create Session" button: enter session name + PIN, generates session code + QR
- Active session view:
  - QR code (using a QR JS library, e.g., qrcode-generator CDN)
  - "Now Playing" card (current song, click to mark as played)
  - Queue list sorted by votes (highest first)
  - Each request has buttons: Play (sets status=playing, moves current to played), Skip, Delete
  - Drag handle for manual reorder (stretch goal, not MVP)
  - "Close Requests" toggle
  - Count of total requests + unique requesters
- Auto-refreshes every 5 seconds

## Frontend Design

### Style
- Dark theme (musician-friendly for dim venues)
- Large text, high contrast (readable from stage)
- Mobile-first (audience is on phones, musician may be on phone or tablet)
- Minimal: no unnecessary decoration

### Colors
- Background: #1a1a2e
- Cards: #16213e
- Accent: #e94560 (for buttons, highlights)
- Text: #eee
- Muted: #888

### Layout
- Audience page: single column, centered, max-width 480px
- DJ dashboard: single column, max-width 600px
- Font: system sans-serif, 16px base

## File Structure
```
jukebox/
├── server.js          -- Express server, API routes, SQLite setup
├── public/
│   ├── index.html     -- Landing page
│   ├── session.html   -- Audience request page
│   ├── dj.html        -- Musician dashboard
│   └── style.css      -- Shared styles
├── jukebox.db         -- SQLite database (auto-created)
└── package.json
```

## Package Dependencies
```json
{
  "dependencies": {
    "express": "^4.18.0",
    "better-sqlite3": "^11.0.0"
  }
}
```

## Behavior Details

### Duplicate Detection
- When submitting a request, check if a queued request exists with same song+artist (case-insensitive, trimmed)
- If duplicate found: auto-upvote instead of creating new request, return the existing request with a `duplicate: true` flag
- Show user: "This song was already requested! We added your vote."

### Voting
- One vote per person per song (tracked by cookie)
- Upvoting is toggle-able: click again to remove vote
- Queue sorts by vote count descending, then by creation time ascending

### Now Playing
- Only one song can be "playing" at a time
- When musician clicks "Play" on a song: any current "playing" song moves to "played", new song becomes "playing"
- Audience page shows "Now Playing" prominently at the top

### Session Lifecycle
1. Musician opens /dj, creates session with name + PIN
2. QR code appears, musician displays it (phone, tablet, or printed)
3. Audience scans QR, lands on request page
4. Requests flow in, musician manages queue
5. Musician closes session when done (no new requests, existing queue stays visible)

### Anonymous Identity
- On first visit, set a cookie `jukebox_id` with a random UUID
- Use this for: tracking who requested what, preventing duplicate votes
- No login, no accounts

## Error Handling
- Invalid session code: "Session not found" page
- Closed session: show queue read-only, hide request form
- Empty song name: client-side validation, don't submit
- Rate limit: max 10 requests per jukebox_id per session (prevent spam)

## Running
```bash
npm install
node server.js
# Server starts on port 3000 (or PORT env var)
```

## Future Enhancements (not in MVP)
- Spotify search autocomplete for song names
- Tip/donate integration
- Setlist planning (musician pre-loads songs)
- Analytics (most requested songs across sessions)
- Multiple musicians/rooms
- WebSocket for instant updates
- PWA for offline queue viewing
