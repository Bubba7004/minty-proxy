import { createBareServer } from "@tomphttp/bare-server-node";
import express from "express";
import { createServer } from "node:http";
import { publicPath } from "ultraviolet-static";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { join } from "node:path";
import { hostname } from "node:os";
import { slimBareResponse } from "./slim-bare.js";
import { diag } from "./diag.js";
import { mountScramjet } from "./scramjet.js";

const bare = createBareServer("/bare/");
const app = express();

app.get("/__diag", diag);
app.use(express.static(publicPath));
// bare-mux worker + transport for the Scramjet option (optional, see scramjet.js)
await mountScramjet(app);
app.use("/minty/", express.static(uvPath));
app.get("/calculus", (req, res) => {
  res.sendFile(join(publicPath, "calculus.html"));
});
app.get("/record", (req, res) => {
  res.sendFile(join(publicPath, "record.html"));
});

app.use((req, res) => {
  res.status(404);
  res.sendFile(join(publicPath, "404.html"));
});

// Heavy sites (YouTube especially) send very large cookie/header sets, and the
// proxy tunnels them inside a single header. Node's 16KB default rejects those
// with a 431, so allow more.
const server = createServer({ maxHeaderSize: 64 * 1024 });

// Aborted streams and resets are normal when proxying video; they must never
// take the whole process down (the host then shows its "server isn't running" page).
server.on("connection", (socket) => {
  socket.on("error", () => {});
});
server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (kept running):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (kept running):", reason);
});

server.on("request", (req, res) => {
  if (bare.shouldRoute(req)) {
    slimBareResponse(req, res);
    bare.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  } else {
    socket.end();
  }
});

server.on("error", (err) => {
  console.error("Server error:", err);
});

// Check both standard PORT and Wispbyte/Pterodactyl SERVER_PORT
let port = parseInt(process.env.PORT || process.env.SERVER_PORT || "", 10);
if (isNaN(port)) port = 16295;

server.on("listening", () => {
  const address = server.address();
  console.log("Listening on:");
  console.log(`\thttp://0.0.0.0:${address.port}`);
  console.log(`\thttp://${hostname()}:${address.port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close();
  bare.close();
  process.exit(0);
}

// Bind explicitly to 0.0.0.0 using the resolved port
server.listen(port, "0.0.0.0", () => {
  console.log(`Server successfully started on port ${port}`);
  console.log("minty build 6: header slimming, /__diag, 64KB header limit, Scramjet option");
});