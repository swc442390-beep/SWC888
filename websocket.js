const WebSocket = require('ws');

let wss;
let clients = [];

function initWebSocket(server) {
  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log("Client connected");

    clients.push(ws);

    ws.on('close', () => {
      console.log("Client disconnected");
      clients = clients.filter(c => c !== ws);
    });

    ws.on('error', () => {
      clients = clients.filter(c => c !== ws);
    });
  });
}

function broadcast(type, data) {
  const message = JSON.stringify({ type, data });

  clients = clients.filter(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      return true;
    }
    return false;
  });
}

module.exports = {
  initWebSocket,
  broadcast
};