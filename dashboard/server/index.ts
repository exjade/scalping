import express from "express";
import path from "node:path";
import { BotDataReader } from "./bot-data-reader.js";

const app = express();
const reader = new BotDataReader();
const port = Number(process.env.DASHBOARD_PORT ?? 4174);
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--serve-dist");
const dashboardRoot = process.cwd();

app.disable("x-powered-by");
app.get("/api/health", (_request, response) => response.json({ ok: true }));
app.get("/api/snapshot", (_request, response) => response.json(reader.current()));

app.get("/events", (request, response) => {
  response.status(200);
  response.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  response.write(`event: snapshot\ndata: ${JSON.stringify(reader.current())}\n\n`);
  const unsubscribe = reader.subscribe((snapshot) => {
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 18_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

if (isProduction) {
  const clientDist = path.join(dashboardRoot, "dist");
  app.use(express.static(clientDist));
  app.get(/.*/, (_request, response) => response.sendFile(path.join(clientDist, "index.html")));
}

await reader.start();
app.listen(port, "127.0.0.1", () => {
  console.log(`PEARL dashboard API listening at http://127.0.0.1:${port}`);
});

const shutdown = () => {
  reader.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
