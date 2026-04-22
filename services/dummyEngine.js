const { broadcast } = require('../websocket');
const pool = require('../db/connection');

let running = false;

/**
 * START DUMMY ENGINE
 */
async function startDummyEngine(declaratorId) {
    if (running) return;

    running = true;
    await console.log("🔥 Dummy engine started");

    runWave(declaratorId);
}

/**
 * MAIN LOOP (dynamic speed using setTimeout)
 */
async function runWave(declaratorId) {
    if (!running) return;

    try {
        const gameRes = await pool.query(`
            SELECT * FROM games
            WHERE status='OPEN'
            ORDER BY created_at DESC
            LIMIT 1
        `);

        if (gameRes.rows.length === 0) {
            stopDummyEngine();
            return;
        }

        const game = gameRes.rows[0];

        // ⏱ GAME TIME
        const startTime = new Date(game.created_at).getTime();
        const elapsed = (Date.now() - startTime) / 1000;

        let intervalSpeed;
        let minBet, maxBet;

        // 🟢 EARLY: fast + small
        if (elapsed < 30) {
            intervalSpeed = randomRange(100, 300); 
            minBet = 20;
            maxBet = 1000;

        // 🟡 MID: balanced
        } else if (elapsed < 90) {
            intervalSpeed = randomRange(200, 800);
            minBet = 100;
            maxBet = 2000;

        // 🔴 LATE: slow + random (small OR medium)
        } else {
            intervalSpeed = randomRange(500, 2000);

            if (Math.random() < 0.5) {
                minBet = 500;
                maxBet = 5000;
            } else {
                minBet = 1000;
                maxBet = 10000;
            }

            // 💥 BIG SPIKE
            if (Math.random() < 0.2) {
                minBet = 2000;
                maxBet = 15000;
            }
        }

        // 🎲 WAVE SIZE
        const waveTotal = randomRange(minBet, maxBet);

        // 🎯 BIAS
        const bias = Math.random();

        let meronRatio, walaRatio, drawRatio;

        if (bias < 0.45) {
            meronRatio = randomRange(55, 65);
            walaRatio = randomRange(30, 40);
            drawRatio = randomRange(3, 8);
        } else if (bias < 0.85) {
            meronRatio = randomRange(40, 55);
            walaRatio = randomRange(40, 55);
            drawRatio = randomRange(1, 5);
        } else {
            meronRatio = randomRange(30, 45);
            walaRatio = randomRange(50, 65);
            drawRatio = randomRange(1, 5);
        }

        const totalPercent = meronRatio + walaRatio + drawRatio;

        const meron = Math.floor((waveTotal * meronRatio) / totalPercent);
        const wala = Math.floor((waveTotal * walaRatio) / totalPercent);
        const draw = Math.max(0, waveTotal - meron - wala);

        // 🔥 MICRO BET FLOW
        await Promise.all([
            injectMicroBets(game.id, declaratorId, 'MERON', meron, elapsed),
            injectMicroBets(game.id, declaratorId, 'WALA', wala, elapsed),
            Math.random() < 0.4
                ? injectMicroBets(game.id, declaratorId, 'DRAW', draw, elapsed)
                : Promise.resolve()
        ]);
        // 🔥 FORCE UI UPDATE AFTER DUMMY BETS
        const gameRes2 = await pool.query(`
            SELECT id FROM games
            ORDER BY created_at DESC
            LIMIT 1
        `);

        if (gameRes2.rows.length > 0) {
            const gameId = gameRes2.rows[0].id;

            const totals = await pool.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN side='MERON' THEN amount END),0) AS meron,
                    COALESCE(SUM(CASE WHEN side='WALA' THEN amount END),0) AS wala,
                    COALESCE(SUM(CASE WHEN side='DRAW' THEN amount END),0) AS draw
                FROM bets
                WHERE game_id = $1
            `, [gameId]);

            const betsList = await pool.query(`
                SELECT b.side, b.amount, u.username
                FROM bets b
                LEFT JOIN users u ON b.user_id = u.id
                WHERE b.game_id = $1
                ORDER BY b.created_at ASC
            `, [gameId]);

            const gameState = {
                fightNumber: game.fight_number || game.fightNumber || 0,
                status: game.status,
                totalMeron: Number(totals.rows[0].meron),
                totalWala: Number(totals.rows[0].wala),
                totalDraw: Number(totals.rows[0].draw),
                playerMeron: Number(totals.rows[0].meron), // temporary (or separate query)
                playerWala: Number(totals.rows[0].wala),
                stream_enabled: game.stream_enabled
            };

            const bets = {
                meron: betsList.rows.filter(b => b.side === 'MERON'),
                wala: betsList.rows.filter(b => b.side === 'WALA')
            };

            broadcast("STATE_UPDATE", {
                game: gameState,
                bets
            });
        }
        if (Math.random() < 0.25) {
            await injectMicroBets(game.id, declaratorId, 'DRAW', draw, elapsed);
        }

        console.log(`Wave | ${elapsed.toFixed(1)}s | M:${meron} W:${wala} D:${draw}`);

        // 🔁 LOOP
        setTimeout(() => runWave(declaratorId), intervalSpeed);

    } catch (err) {
        console.error("Dummy engine error:", err);
        setTimeout(() => runWave(declaratorId), 1000);
    }
}

/**
 * MICRO BETS (smooth realistic flow)
 */
async function injectMicroBets(gameId, declaratorId, side, totalAmount, elapsed) {
    let remaining = totalAmount;

    const promises = [];

    while (remaining > 0) {
        // 🔥 bigger chunks = fewer loops
        const chunk = Math.min(remaining, randomRange(50, 600));
        remaining -= chunk;

        promises.push(
            insertDummyBet(gameId, declaratorId, side, chunk)
        );

        // ⚡ reduce delay pressure
        if (promises.length >= 5) {
            await Promise.all(promises);
            promises.length = 0;
        }
    }

    // flush remaining
    if (promises.length > 0) {
        await Promise.all(promises);
    }
}

/**
 * STOP ENGINE
 */
function stopDummyEngine() {
    running = false;
    console.log("🛑 Dummy engine stopped");
}

/**
 * INSERT DUMMY BET
 */
async function insertDummyBet(gameId, declaratorId, side, amount) {
    if (!amount || amount <= 0) return;

    await pool.query(`
        INSERT INTO bets (game_id, user_id, side, amount, is_dummy)
        VALUES ($1, $2, $3, $4, true)
    `, [gameId, declaratorId, side, amount]);
}

/**
 * RANDOM HELPER
 */
function randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
    startDummyEngine,
    stopDummyEngine
};