let socket;
let gameUpdateTimeout = null;
// ==========================
// CONNECT WEBSOCKET
// ==========================
function connectSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}`);

    socket.onopen = () => {
        console.log("✅ WebSocket Connected");
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("📡 WS:", data);

        switch (data.type) {

            case "STATE_UPDATE":
                applyState(data.payload);
                break;

            case "EVENT_UPDATE":
                updateAnnouncement(data.announcement);
                break;
        }
    };

    socket.onclose = () => {
        console.log("❌ WebSocket Disconnected. Reconnecting...");
        setTimeout(connectSocket, 3000);
    };
}

// ==========================
// LOAD GAME STATUS
// ==========================
async function loadGameStatus() {
    try {
        const res = await fetch('/api/game-status', {
            credentials: 'include'
        });

        if (res.status === 401) {
            window.location.href = '/index.html';
            return;
        }

        const data = await res.json();

        setText('fightNumber', data.fightNumber);
        setText('status', data.status);

        setText('meronTotal', formatNumber(data.totalMeron));
        setText('walaTotal', formatNumber(data.totalWala));
        setText('drawTotal', formatNumber(data.totalDraw));

        setText('myMeron', formatNumber(data.myMeron));
        setText('myWala', formatNumber(data.myWala));
        setText('myDraw', formatNumber(data.myDraw));

    } catch (err) {
        console.error(err);
    }
}

// ==========================
// PLACE BET
// ==========================
async function placeBet(side) {
    const amount = Number(document.getElementById('betAmount').value);

    if (!amount || amount <= 0) {
        alert("Invalid amount");
        return;
    }

    try {
        const res = await fetch('/api/place-bet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ side, amount })
        });

        const data = await res.json();

        if (!res.ok) {
            alert(data.error);
            return;
        }

        loadGameStatus();

    } catch (err) {
        console.error(err);
    }
}

// ==========================
// ACTIVE BETS
// ==========================
async function loadActiveBets() {
    try {
        const res = await fetch('/api/active-bets', {
            credentials: 'include'
        });

        const data = await res.json();

        renderBetList('meronBets', data.meron);
        renderBetList('walaBets', data.wala);

    } catch (err) {
        console.error(err);
    }
}

// ==========================
// RENDER LIST
// ==========================
function renderBetList(id, bets) {
    const el = document.getElementById(id);
    if (!el) return;

    el.innerHTML = '';

    bets.forEach(b => {
        const div = document.createElement('div');
        div.textContent = `${b.username} - ${formatNumber(b.amount)}`;
        el.appendChild(div);
    });
}

// ==========================
// HELPERS
// ==========================
function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function formatNumber(num) {
    return Number(num || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function updateAnnouncement(text) {
    const el = document.getElementById('announcement');
    if (el) el.textContent = text || '';
}
function applyState(payload) {
    const game = payload.game;
    const bets = payload.bets;

    if (game) {
        setText('fightNumber', game.fightNumber);
        setText('status', game.status);

        setText('meronTotal', formatNumber(game.totalMeron));
        setText('walaTotal', formatNumber(game.totalWala));
        setText('drawTotal', formatNumber(game.totalDraw));

        setText('myMeron', formatNumber(game.myMeron));
        setText('myWala', formatNumber(game.myWala));
        setText('myDraw', formatNumber(game.myDraw));
    }

    if (bets) {
        renderBetList('meronBets', bets.meron);
        renderBetList('walaBets', bets.wala);
    }
}
// ==========================
// LOAD ACTIVE EVENT
// ==========================
async function loadActiveEvent() {
    try {
        const res = await fetch('/api/active-event');
        const data = await res.json();

        console.log("🎯 ACTIVE EVENT:", data);

        setText('eventName', data.event_name || '');
        setText('announcement', data.announcement || '');

        // 🎥 Video handling
        const videoFrame = document.getElementById('videoFrame');
        if (videoFrame && data.video_url) {
            videoFrame.src = data.video_url;
        }

        // 📺 Stream toggle
        const streamContainer = document.getElementById('streamContainer');
        if (streamContainer) {
            streamContainer.style.display = data.stream_enabled ? 'block' : 'none';
        }

    } catch (err) {
        console.error("Active event load error:", err);
    }
}

// ==========================
// INIT
// ==========================
connectSocket();
loadGameStatus();
loadActiveBets();
loadActiveEvent();

