router.get('/superadmin/dashboard', isSuperAdmin, async (req, res) => {
    try {
        console.log("📊 Loading superadmin dashboard...");

        // ==========================
        // AGENTS
        // ==========================
        const agents = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE role IN ('agent','sub_agent','master_agent')) AS total,
                COUNT(*) FILTER (WHERE status = 'online' AND role IN ('agent','sub_agent','master_agent')) AS online,
                COUNT(*) FILTER (WHERE status = 'offline' AND role IN ('agent','sub_agent','master_agent')) AS offline,
                COUNT(*) FILTER (WHERE status = 'pending' AND role IN ('agent','sub_agent','master_agent')) AS pending
            FROM users
        `);

        // ==========================
        // PLAYERS
        // ==========================
        const players = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE role = 'player') AS total,
                COUNT(*) FILTER (WHERE status = 'online' AND role = 'player') AS online,
                COUNT(*) FILTER (WHERE status = 'offline' AND role = 'player') AS offline,
                COUNT(*) FILTER (WHERE status = 'pending' AND role = 'player') AS pending
            FROM users
        `);

        // ==========================
        // BETS
        // ==========================
        const bets = await pool.query(`
            SELECT COALESCE(SUM(amount), 0) AS total_bet
            FROM bets
            WHERE is_dummy = false
        `);

        // ==========================
        // CASH FLOW
        // ==========================
        const cash = await pool.query(`
            SELECT
                COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS cash_in,
                COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS withdraw
            FROM wallet_transactions
        `);

        // ✅ SINGLE CLEAN RESPONSE
        const response = {
            totalAgents: Number(agents.rows[0]?.total || 0),
            onlineAgents: Number(agents.rows[0]?.online || 0),
            offlineAgents: Number(agents.rows[0]?.offline || 0),
            pendingAgents: Number(agents.rows[0]?.pending || 0),

            totalPlayers: Number(players.rows[0]?.total || 0),
            onlinePlayers: Number(players.rows[0]?.online || 0),
            offlinePlayers: Number(players.rows[0]?.offline || 0),
            pendingPlayers: Number(players.rows[0]?.pending || 0),

            totalBet: Number(bets.rows[0]?.total_bet || 0),
            totalWon: 0,

            totalCashIn: Number(cash.rows[0]?.cash_in || 0),
            totalWithdraw: Number(cash.rows[0]?.withdraw || 0)
        };

        console.log("✅ Dashboard Data:", response);

        res.json(response);

    } catch (err) {
        console.error("❌ SUPERADMIN DASHBOARD ERROR:", err);
        res.status(500).json({ error: err.message });
    }
});