//Its job is to start the server and initialize WebSocket
import http from "http";
import dotenv from "dotenv";
import app from "./app.js";
import { initializeWebSocket } from "./services/webSocketService.js";

dotenv.config();

const port = process.env.PORT || 8787;
const server = http.createServer(app);

// Initialize the WebSocket server
initializeWebSocket(server);

server.listen(port, () => {
  console.log(`✓ Server with WebSocket listening on http://localhost:${port}`);
});