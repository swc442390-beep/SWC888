const pool = require('../db/connection');

let interval = null;
let running = false;

/**
 * START DUMMY ENGINE
 */
async function startDummyEngine(declaratorId) {
    if (running) return;

    running = true;

    console.log("🔥 Dummy engine started");

    interval = setInterval(async () => {
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

            // 🎲 generate wave size (2k - 15k)
            const waveTotal = randomRange(2000, 15000);

            // 🎯 random bias shift per wave
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

            // 💾 insert dummy bets
            await insertDummyBet(game.id, declaratorId, 'MERON', meron);
            await insertDummyBet(game.id, declaratorId, 'WALA', wala);

            if (Math.random() < 0.25) {
                await insertDummyBet(game.id, declaratorId, 'DRAW', draw);
            }

            console.log(`Wave injected: M:${meron} W:${wala} D:${draw}`);

        } catch (err) {
            console.error("Dummy engine error:", err);
        }
    }, randomRange(8000, 15000)); // wave interval
}

/**
 * STOP ENGINE
 */
function stopDummyEngine() {
    if (interval) clearInterval(interval);
    interval = null;
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
 * RANDOM RANGE HELPER
 */
function randomRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
    startDummyEngine,
    stopDummyEngine
};