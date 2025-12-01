# Infinite Monkeys

A local demo web application that:

- Generates 1 random keyboard character on the server every second (shared for all visitors)
- Saves each character to a local SQLite database (data/monkeys.db)
- Broadcasts new characters to connected browsers via Server-Sent Events (SSE)
- The web page shows the last X characters. X is a global constant set in the server code (DISPLAY_LIMIT)
- Keeps the newest up to 1,000,000 rows readily in the main DB. Older rows are archived into compressed files (data/archive) for storage efficiency.

Quick start (local):
1. Install dependencies
   npm install

2. Start the server
   npm start

3. Open:
   http://localhost:3000

Docker:
1. Build image:
   docker build -t infinite-monkeys .

2. Run:
   docker run -p 3000:3000 --name infinite-monkeys infinite-monkeys

Configuration:
- To change the number of characters shown on the page, edit the DISPLAY_LIMIT constant in server.js and restart the server.
- To change how many rows are kept in the main DB before archiving, edit MAX_KEEP in server.js.

Data/archiving:
- Main DB: data/monkeys.db
- Archive files: data/archive/archive-<lastId>-<timestamp>.json.gz (JSON Lines)
