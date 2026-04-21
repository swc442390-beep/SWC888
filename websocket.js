const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 3001 });

let clients = [];

wss.on('connection', (ws) => {
    console.log("Client connected");

    clients.push(ws);

    ws.on('close', () => {
        console.log("Client disconnected");
        clients = clients.filter(c => c !== ws);
    });
});

// ✅ THIS is what your APIs will use
function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });

    clients = clients.filter(ws => ws.readyState === WebSocket.OPEN);

    clients.forEach(ws => {
        ws.send(msg);
    });
}

module.exports = { broadcast };