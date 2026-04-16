const pool = require('../db/connection');

let running = false;

/**
 * START DUMMY ENGINE
 */
async function startDummyEngine(declaratorId) {
    if (running) return;

    running = true;
    console.log("🔥 Dummy engine started");

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
             intervalSpeed = randomRange(100, 300); // ⚡ faster waves
            minBet = 20;
            maxBet = 200;

        // 🟡 MID: balanced
        } else if (elapsed < 90) {
            intervalSpeed = randomRange(800, 2000);
            minBet = 100;
            maxBet = 800;

        // 🔴 LATE: slow + random (small OR medium)
        } else {
            intervalSpeed = randomRange(1500, 4000);

            if (Math.random() < 0.5) {
                minBet = 50;
                maxBet = 300;
            } else {
                minBet = 300;
                maxBet = 1500;
            }

            // 💥 rare spike
            if (Math.random() < 0.1) {
                minBet = 2000;
                maxBet = 8000;
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
        await injectMicroBets(game.id, declaratorId, 'MERON', meron, elapsed);
        await injectMicroBets(game.id, declaratorId, 'WALA', wala, elapsed);

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