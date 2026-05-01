const express = require('express');
const router = express.Router();
const pool = require('../db/connection');

// ✅ Middleware
function isSuperAdmin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.session.user.role !== '-1') {
        return res.status(403).json({ error: "Forbidden" });
    }

    next();
}

// ✅ Helper: map status counts safely
function mapStatus(rows) {
    const map = {
        online: 0,
        offline: 0,
        pending: 0
    };

    rows.forEach(r => {
        if (map.hasOwnProperty(r.status)) {
            map[r.status] = Number(r.count);
        }
    });

    return map;
}

// ✅ Route
router.get('/dashboard', isSuperAdmin, async (req, res) => {
    console.log("🔥 SUPERADMIN DASHBOARD HIT");

    try {
        // =========================
        // TOTAL COUNTS
        // =========================
        const agents = await pool.query(`
            SELECT COUNT(*) AS total
            FROM users
            WHERE role IN ('agent','sub_agent','master_agent')
        `);

        const players = await pool.query(`
            SELECT COUNT(*) AS total
            FROM users
            WHERE role = 'player'
        `);

        // =========================
        // STATUS COUNTS
        // =========================
        const agentStatus = await pool.query(`
            SELECT status, COUNT(*) AS count
            FROM users
            WHERE role IN ('agent','sub_agent','master_agent')
            GROUP BY status
        `);

        const playerStatus = await pool.query(`
            SELECT status, COUNT(*) AS count
            FROM users
            WHERE role = 'player'
            GROUP BY status
        `);

        // =========================
        // GAME FLOW (BETS & WINS)
        // =========================
        const gameFlow = await pool.query(`
            SELECT
                COALESCE(SUM(CASE 
                    WHEN type = 'debit' AND description ILIKE 'Bet on%' 
                    THEN amount ELSE 0 END), 0) AS total_bet,

                COALESCE(SUM(CASE 
                    WHEN type = 'credit' AND description ILIKE 'Win -%' 
                    THEN amount ELSE 0 END), 0) AS total_won
            FROM wallet_transactions
        `);

        // =========================
        // CASH FLOW
        // =========================
        const cash = await pool.query(`
            SELECT
                COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS cash_in,
                COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS withdraw
            FROM wallet_transactions
        `);

        // =========================
        // MAP STATUS RESULTS
        // =========================
        const agentMap = mapStatus(agentStatus.rows);
        const playerMap = mapStatus(playerStatus.rows);

        // =========================
        // FINAL RESPONSE
        // =========================
        return res.json({
            totalAgents: Number(agents.rows[0]?.total || 0),
            totalPlayers: Number(players.rows[0]?.total || 0),

            // ✅ GAME FLOW (FIXED)
            totalBet: Number(gameFlow.rows[0]?.total_bet || 0),
            totalWon: Number(gameFlow.rows[0]?.total_won || 0),

            // ✅ CASH FLOW
            totalCashIn: Number(cash.rows[0]?.cash_in || 0),
            totalWithdraw: Number(cash.rows[0]?.withdraw || 0),

            // ✅ Agent status
            onlineAgents: agentMap.online,
            offlineAgents: agentMap.offline,
            pendingAgents: agentMap.pending,

            // ✅ Player status
            onlinePlayers: playerMap.online,
            offlinePlayers: playerMap.offline,
            pendingPlayers: playerMap.pending
        });

    } catch (err) {
        console.error("❌ SUPERADMIN ERROR:", err);
        return res.status(500).json({
            error: err.message,
            stack: err.stack
        });
    }
});

module.exports = router;