const settleGame = async (gameId, winner) => {
  await pool.query('BEGIN');

  try {
    // ❌ HANDLE CANCELLED (refund all + remove commissions)
    if (winner === 'CANCELLED') {

      // 1. REFUND ONLY UNRESOLVED BETS
      const bets = await pool.query(`
        SELECT id, user_id, amount 
        FROM bets 
        WHERE game_id = $1 AND is_resolved = false
      `, [gameId]);

      for (const bet of bets.rows) {
        await pool.query(`
          UPDATE users 
          SET points = points + $1 
          WHERE id = $2
        `, [bet.amount, bet.user_id]);

        await pool.query(`
          INSERT INTO wallet_transactions
          (user_id, type, amount, balance_after, description)
          VALUES ($1, 'credit', $2,
            (SELECT points FROM users WHERE id=$1),
            $3)
        `, [
          bet.user_id,
          bet.amount,
          `Refund - Game Cancelled`
        ]);
      }

      // ✅ MARK BETS AS RESOLVED
      await pool.query(`
        UPDATE bets
        SET is_resolved = true
        WHERE game_id = $1 AND is_resolved = false
      `, [gameId]);

      // ❌ REMOVE COMMISSIONS
      await pool.query(`
        DELETE FROM commission_transactions
        WHERE game_id = $1
      `, [gameId]);

      await pool.query('COMMIT');
      return;
    }

    // ==========================
    // NORMAL SETTLEMENT
    // ==========================

    // 1. GET UNRESOLVED BETS
    const betsRes = await pool.query(`
      SELECT user_id, side, amount
      FROM bets
      WHERE game_id = $1 AND is_resolved = false
    `, [gameId]);

    const bets = betsRes.rows;

    // 2. GET TOTAL POOLS (ONLY UNRESOLVED)
    const totalsRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN side='MERON' THEN amount END),0) AS meron,
        COALESCE(SUM(CASE WHEN side='WALA' THEN amount END),0) AS wala,
        COALESCE(SUM(CASE WHEN side='DRAW' THEN amount END),0) AS draw
      FROM bets
      WHERE game_id = $1 AND is_resolved = false
    `, [gameId]);

    const totals = totalsRes.rows[0];

    const totalPool =
      Number(totals.meron) +
      Number(totals.wala) +
      Number(totals.draw);

    const CUT = 0.915;

    const payouts = {
      MERON: totals.meron ? (totalPool / totals.meron) * CUT : 0,
      WALA: totals.wala ? (totalPool / totals.wala) * CUT : 0,
      DRAW: 8
    };

    // ❌ SAFETY: no winners
    if (!payouts[winner]) {
      await pool.query('ROLLBACK');
      return;
    }

    // 3. PAY WINNERS
    for (const bet of bets) {
      if (bet.side !== winner) continue;

      const winAmount = Number((bet.amount * payouts[winner]).toFixed(2)); 

      await pool.query(`
        UPDATE users
        SET points = points + $1
        WHERE id = $2
      `, [winAmount, bet.user_id]);

      await pool.query(`
        INSERT INTO wallet_transactions
        (user_id, type, amount, balance_after, description)
        VALUES ($1, 'credit', $2,
          (SELECT points FROM users WHERE id=$1),
          $3)
      `, [
        bet.user_id,
        winAmount,
        `Win - ${winner}`
      ]);
    }

    // ✅ MARK ALL BETS AS RESOLVED (VERY IMPORTANT)
    await pool.query(`
      UPDATE bets
      SET is_resolved = true
      WHERE game_id = $1 AND is_resolved = false
    `, [gameId]);

    await pool.query('COMMIT');

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('SETTLE GAME ERROR:', err);
  }
};
