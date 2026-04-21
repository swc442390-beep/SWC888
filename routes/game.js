const express = require('express');
const router = express.Router();
// ==========================
//  START GAME (DECLARATOR ONLY)
// ==========================
router.post('/start-game', isAuthenticated, async (req, res) => {
  const { fightNumber, event_name } = req.body;

  if (req.session.user.role !== 'declarator') {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    await pool.query('BEGIN');

    // 🔒 LOCK the games table (prevents concurrent start)
    await pool.query('LOCK TABLE games IN EXCLUSIVE MODE');

    // 1. Close any open game
    await pool.query(`
      UPDATE games 
      SET status = 'CLOSED'
      WHERE status = 'OPEN'
    `);

    // 2. Insert new game
    const result = await pool.query(`
      INSERT INTO games (fight_number, status, event_name)
      VALUES ($1, 'OPEN', $2)
      RETURNING *
    `, [fightNumber, event_name]);

    const newGame = result.rows[0];

    await upsertActiveEvent({
      gameId: newGame.id,
      event_name: "",
      announcement: `Game Started - Fight #${fightNumber}`
    });

    await pool.query('COMMIT');

    res.json({
      message: "Game started",
      game: newGame
    });

    // 🔥 Broadcast AFTER commit
    const gameState = await getGlobalGameState();
    broadcast('GAME_UPDATE', {
      type: 'GAME_UPDATE',
      payload: gameState
    });

    startDummyEngine(req.session.user.id);

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("START GAME ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
//  CLOSE GAME (DECLARATOR ONLY)
// ==========================

router.post('/close-game', isAuthenticated, async (req, res) => {
  try {
    if (req.session.user.role !== 'declarator') {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // 1. FIND OPEN GAME FIRST
    const gameRes = await pool.query(`
      SELECT * FROM games WHERE status='OPEN' ORDER BY created_at DESC LIMIT 1
    `);

    if (gameRes.rows.length === 0) {
      return res.status(400).json({ error: "No open game to close" });
    }

    const game = gameRes.rows[0];

    // 2. STOP ENGINE SAFELY (IMPORTANT)
    try {
      stopDummyEngine();
    } catch (e) {
      console.error("Dummy engine stop error:", e);
    }

    // 3. UPDATE SPECIFIC GAME
    const updateRes = await pool.query(`
      UPDATE games
      SET status='CLOSED'
      WHERE id=$1
      RETURNING *
    `, [game.id]);

    await upsertActiveEvent({
      gameId: game.id,
      event_name: "",
      announcement: `Betting Closed`,
      
    });
    const gameState = await getGlobalGameState();
    broadcast('GAME_UPDATE', {
      type: 'GAME_UPDATE',
      payload: gameState
    });

    return res.json({
      message: "Betting closed",
      game: updateRes.rows[0]
    });

  } catch (err) {
    console.error("CLOSE GAME ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ==========================
//  DECLARE WINNER (DECLARATOR ONLY)
// ==========================
router.post('/declare-winner', isAuthenticated, async (req, res) => {
  const { winner } = req.body;

  stopDummyEngine();

  try {
    if (req.session.user.role !== 'declarator') {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const result = await pool.query(`
      UPDATE games
      SET winner=$1, status='RESOLVED'
      WHERE status='CLOSED'
      RETURNING *
    `, [winner]);

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "No closed game to resolve" });
    }

    const gameId = result.rows[0].id;

    // 🔥 VERY IMPORTANT (THIS WAS MISSING)
    

    let announcementText = "";

    if (winner === "CANCELLED") {
      announcementText = "GAME CANCELLED - ALL BETS REFUNDED";
    } else {
      announcementText = `${winner} WINS!`;
    }

    await upsertActiveEvent({
      gameId: gameId,
      event_name: "",
      announcement: announcementText,
    });

    res.json({
      message: "Winner declared",
      game: result.rows[0]
    });

    const gameState = await getGlobalGameState();
    broadcast('GAME_UPDATE', {
      type: 'GAME_UPDATE',
      payload: gameState
    });

    await settleGame(gameId, winner);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// PLACE BET API
// ==========================
router.post('/place-bet', isAuthenticated, async (req, res) => {

    const userId = req.session.user.id;
    const validSides = ['MERON', 'WALA', 'DRAW'];
    const { side, amount } = req.body;

    if (!validSides.includes(side)) {
      return res.status(400).json({ error: "Invalid side" });
    }const { side, amount } = req.body;

    try {
        const result = await placeBet(userId, side, Number(amount));

        // 🔥 GET UPDATED GAME STATE
        const gameState = await getGameState(userId);

        // 🔥 SEND TO ALL CLIENTS
        broadcast('GAME_UPDATE', {
          type: 'GAME_UPDATE',
          payload: gameState
        });

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message });
    }
});


// ==========================
// GAME STATUS API (🔥 REQUIRED)
// ==========================
router.get('/game-status', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;

        const result = await pool.query(`
            SELECT 
                g.id,
                g.fight_number,
                g.status,

                -- TOTAL BETS
                COALESCE(SUM(CASE WHEN b.side='MERON' THEN b.amount END),0) AS "totalMeron",
                COALESCE(SUM(CASE WHEN b.side='WALA' THEN b.amount END),0) AS "totalWala",
                COALESCE(SUM(CASE WHEN b.side='DRAW' THEN b.amount END),0) AS "totalDraw",

                -- USER BETS
                COALESCE(SUM(CASE WHEN b.side='MERON' AND b.user_id=$1 THEN b.amount END),0) AS "myMeron",
                COALESCE(SUM(CASE WHEN b.side='WALA' AND b.user_id=$1 THEN b.amount END),0) AS "myWala",
                COALESCE(SUM(CASE WHEN b.side='DRAW' AND b.user_id=$1 THEN b.amount END),0) AS "myDraw",

                -- PLAYER BETS (REAL USERS ONLY)
                COALESCE(SUM(CASE WHEN b.side='MERON' AND b.is_dummy=false AND u.role='player' THEN b.amount END),0) AS "playerMeron",
                COALESCE(SUM(CASE WHEN b.side='WALA' AND b.is_dummy=false AND u.role='player' THEN b.amount END),0) AS "playerWala",
                COALESCE(SUM(CASE WHEN b.side='DRAW' AND b.is_dummy=false AND u.role='player' THEN b.amount END),0) AS "playerDraw"

            FROM games g
            LEFT JOIN bets b ON b.game_id = g.id
            LEFT JOIN users u ON u.id = b.user_id

            WHERE g.id = (
                SELECT id FROM games ORDER BY created_at DESC LIMIT 1
            )

            GROUP BY g.id
        `, [userId]);

        // ✅ NO GAME CASE
        if (result.rows.length === 0) {
            return res.json({
                fightNumber: 0,
                status: "CLOSED",
                totalMeron: 0,
                totalWala: 0,
                totalDraw: 0,
                myMeron: 0,
                myWala: 0,
                myDraw: 0,
                playerMeron: 0,
                playerWala: 0,
                playerDraw: 0
            });
        }

        const data = result.rows[0];

        res.json({
            fightNumber: data.fight_number,
            status: data.status,

            totalMeron: Number(data.totalMeron),
            totalWala: Number(data.totalWala),
            totalDraw: Number(data.totalDraw),

            myMeron: Number(data.myMeron),
            myWala: Number(data.myWala),
            myDraw: Number(data.myDraw),

            playerMeron: Number(data.playerMeron),
            playerWala: Number(data.playerWala),
            playerDraw: Number(data.playerDraw)
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// ==========================
// ACTIVE GAME BETS (WITH USERNAMES)
// ==========================
router.get('/active-bets', isAuthenticated, async (req, res) => {
  try {
    // 🔍 Get latest game
    const gameRes = await pool.query(`
      SELECT id FROM games
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (gameRes.rows.length === 0) {
      return res.json({ meron: [], wala: [] });
    }

    const gameId = gameRes.rows[0].id;

    // 🔍 Get bets with usernames
    const betsRes = await pool.query(`
      SELECT b.side, b.amount, u.username
      FROM bets b
      JOIN users u ON u.id = b.user_id
      WHERE b.game_id = $1
        AND b.is_dummy = false          -- ❌ REMOVE dummy bets
        AND u.role = 'player'           -- ❌ REMOVE declarator/admin/agents
      ORDER BY b.created_at ASC
    `, [gameId]);

    const meron = [];
    const wala = [];

    for (const bet of betsRes.rows) {
      if (bet.side === 'MERON') meron.push(bet);
      if (bet.side === 'WALA') wala.push(bet);
    }

    res.json({ meron, wala });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// GAME HISTORY API
// ==========================

router.get('/game-history', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT g.winner
            FROM games g
            JOIN active_event ae
                ON g.event_name = ae.event_name
            WHERE g.winner IS NOT NULL
            ORDER BY g.id ASC
            LIMIT 200
        `);

        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

// ==========================
// BEADS HISTORY WITH COUNT
// ==========================
router.get('/beads-history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.winner
      FROM games g
      JOIN active_event ae
        ON g.event_name = ae.event_name
      WHERE g.winner IS NOT NULL
      ORDER BY g.id ASC
      LIMIT 200
    `);

    const history = result.rows.map(r => r.winner);

    const counts = {
      MERON: history.filter(x => x === 'MERON').length,
      WALA: history.filter(x => x === 'WALA').length,
      DRAW: history.filter(x => x === 'DRAW').length,
      CANCELLED: history.filter(x => x === 'CANCELLED').length
    };

    res.json({
      history,
      counts
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch beads history" });
  }
});