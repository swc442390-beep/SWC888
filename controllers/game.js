const pool = require('../db/connection');

// ==========================
// GET OPEN GAME
// ==========================
async function getOpenGame() {
    const result = await pool.query(
        `SELECT * FROM games WHERE status='OPEN' LIMIT 1`
    );
    return result.rows[0];
}
// ==========================
// GET USER
// ==========================
async function getUser(id){
    const res = await pool.query(
        `SELECT * FROM users WHERE id=$1`,
        [id]
    );
    return res.rows[0];
}

// ==========================
// DISTRIBUTE COMMISSION
// ==========================
async function distributeCommission(userId, amount, gameId, betId) {

    let currentUser = await getUser(userId);
    let prevRate = 0;
    let level = 1;

    while (currentUser.parent_id) {

        const parent = await getUser(currentUser.parent_id);
        const parentRate = Number(parent.commission_rate || 0);
        const diffRate = parentRate - prevRate;

        if (diffRate > 0) {

            const commission = amount * (diffRate / 100);

            await pool.query(`
                UPDATE users
                SET commission_earnings = commission_earnings + $1
                WHERE id = $2
            `,[commission, parent.id]);

            await pool.query(`
                INSERT INTO commission_transactions
                (user_id, source_user_id, game_id, bet_id, amount, rate, level, base_amount)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `,[
                parent.id,
                userId,
                gameId,
                betId,
                commission,
                diffRate,
                level,
                amount
            ]);

            prevRate = parentRate;
        }

        currentUser = parent;
        level++;
    }
}
// ==========================
// PLACE BET
// ==========================
async function placeBet(userId, side, amount) {

    await pool.query('BEGIN');

    try {

        // ✅ STEP 1: GET OPEN GAME
        const game = await getOpenGame();

        if (!game) throw new Error("No active game");

        // ✅ STEP 2: GET USER
        const userRes = await pool.query(
            `SELECT points FROM users WHERE id=$1`,
            [userId]
        );

        const user = userRes.rows[0];

        if (user.points < amount) {
            throw new Error("Insufficient balance");
        }

        // ✅ STEP 3: DEDUCT BALANCE
        const newBalance = user.points - amount;

        await pool.query(`
            UPDATE users SET points=$1 WHERE id=$2
        `,[newBalance, userId]);

        // ✅ STEP 4: INSERT BET
        const betRes = await pool.query(`
            INSERT INTO bets(game_id,user_id,side,amount)
            VALUES($1,$2,$3,$4)
            RETURNING id
        `,[game.id, userId, side, amount]);

        const betId = betRes.rows[0].id;

        // ✅ STEP 5: WALLET LOG
        await pool.query(`
            INSERT INTO wallet_transactions
            (user_id,type,amount,balance_after,description)
            VALUES($1,'debit',$2,$3,$4)
        `,[
            userId,
            amount,
            newBalance,
            `Bet on ${side} Game ${game.id}`
        ]);

        // ✅ STEP 6: COMMISSION
        await distributeCommission(userId, amount, game.id, betId);

        await pool.query('COMMIT');

        return { success: true };

    } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
    }
}

module.exports = {
    placeBet,
    getOpenGame
};
