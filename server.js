// ==========================
// IMPORTS
// ==========================
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const pool = require('./db/connection');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const app = express();
const allowedOrigin = 'https://letsplay-famw.onrender.com';
const { placeBet } = require('./controllers/game');
const { startDummyEngine, stopDummyEngine } = require('./services/dummyEngine');

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 15 minutes
  max: 5, // allow max 5 attempts per window per IP
  message: {
    error: "Too many login attempts, please try again after 5 minutes"
  },
  standardHeaders: true, // return rate limit info in headers
  legacyHeaders: false,  // disable X-RateLimit-* headers
});

// ==========================
// 💰 SETTLE GAME FUNCTION
// ==========================
const settleGame = async (gameId, winner) => {

// ❌ HANDLE CANCELLED (refund all)
      if (winner === 'CANCELLED') {
        const bets = await pool.query(`
          SELECT user_id, amount FROM bets WHERE game_id = $1
        `, [gameId]);

        for (const bet of bets.rows) {
          await pool.query(`
            UPDATE users SET points = points + $1 WHERE id = $2
          `, [bet.amount, bet.user_id]);
        }

        return;
      }

      // 1. GET ALL BETS
      const betsRes = await pool.query(`
        SELECT user_id, side, amount
        FROM bets
        WHERE game_id = $1
      `, [gameId]);

      const bets = betsRes.rows;

      // 2. GET TOTAL POOLS
      const totalsRes = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN side='MERON' THEN amount END),0) AS meron,
          COALESCE(SUM(CASE WHEN side='WALA' THEN amount END),0) AS wala,
          COALESCE(SUM(CASE WHEN side='DRAW' THEN amount END),0) AS draw
        FROM bets
        WHERE game_id = $1
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
      if (!payouts[winner]) return;

      // 3. PROCESS WINNERS
      for (const bet of bets) {
        if (bet.side !== winner) continue;

        const winAmount = bet.amount * payouts[winner];

        // ➕ ADD WINNINGS
        await pool.query(`
          UPDATE users
          SET points = points + $1
          WHERE id = $2
        `, [winAmount, bet.user_id]);

        // 📝 LOG
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
    };
// ==========================
// HELPER FUNCTIONS (ADD HERE)
// ==========================

const upsertActiveEvent = async ({ gameId, event_name, announcement }) => {
  const check = await pool.query(`SELECT * FROM active_event WHERE id = 1`);

  // ✅ Use existing event_name if not provided
  if (!event_name && check.rows.length > 0) {
    event_name = check.rows[0].event_name;
  }

  if (check.rows.length === 0) {
    await pool.query(`
      INSERT INTO active_event (id, game_id, event_name, announcement)
      VALUES (1, $1, $2, $3)
    `, [gameId, event_name, announcement]);
  } else {
    await pool.query(`
      UPDATE active_event
      SET game_id = $1,
          event_name = $2,
          announcement = $3,
          updated_at = NOW()
      WHERE id = 1
    `, [gameId, event_name, announcement]);
    
  }
};

// ==========================
// MIDDLEWARE
// ==========================
app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));

app.use(express.json());


// Prevent caching (important after logout)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ==========================
// SESSION CONFIG (FIXED)
// ==========================
app.set('trust proxy', 1); // ✅ REQUIRED for Render (IMPORTANT)

app.use(session({
  store: new PgSession({
    pool: pool,
    tableName: 'user_sessions'
  }),
  secret: 'super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,        // ✅ REQUIRED for HTTPS (Render)
    httpOnly: true,
    sameSite: 'none',    // ✅ REQUIRED for cross-site cookies
    maxAge: 1000 * 60 * 30
  }
}));

// ==========================
// AUTH MIDDLEWARE
// ==========================
function isAuthenticated(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ==========================
// ROLE AUTHORIZATION
// ==========================
function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/');
    }

    if (!roles.includes(req.session.user.role)) {
      return res.status(403).send("Forbidden");
    }

    next();
  };
}

// ==========================
// LOGIN ROUTE (FIXED)
// ==========================
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "User not found" });
    }

    const user = result.rows[0];
    // ❌ BLOCK PENDING USERS
    if (user.status === 'pending') {
      return res.status(403).json({ 
        error: "Account pending approval. Please wait for approval." 
      });
    }
    if (user.status === 'suspended') {
      return res.status(403).json({ 
        error: "Your account has been suspended." 
      });
    }
    // Check if account is locked
    if (user.lock_until && new Date() < user.lock_until) {
      const minutesLeft = Math.ceil((new Date(user.lock_until) - new Date()) / 60000);
      return res.status(403).json({ error: `Account locked. Try again in ${minutesLeft} minute(s).` });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      // Increment failed login attempts
      let failedAttempts = user.failed_logins + 1;
      let lockUntil = null;

      if (failedAttempts >= 5) {   // lock after 5 failed attempts
        lockUntil = new Date(Date.now() + 5 * 60 * 1000); // lock 15 minutes
        failedAttempts = 0; // reset counter after lock
      }

      await pool.query(
        'UPDATE users SET failed_logins = $1, lock_until = $2 WHERE id = $3',
        [failedAttempts, lockUntil, user.id]
      );

      return res.status(401).json({ error: lockUntil ? "Account temporarily locked due to repeated failed attempts." : "Wrong password" });
    }

    // ✅ Reset failed login count on success
    await pool.query(
      'UPDATE users SET failed_logins = 0, lock_until = NULL, status = $1 WHERE id = $2',
      ['online', user.id]
    );

    // ✅ Existing session save logic
    req.session.user = { id: user.id, username: user.username, role: user.role };
    req.session.save(async (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Session error" });
      }

      res.json({
        message: "Login success",
        role: user.role,
        id: user.id,
        points: user.points || 0
      });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// ROLE-PROTECTED PAGES
// ==========================
app.get('/admin.html', authorizeRoles('admin','master_agent', 'sub_agent', 'agent'), (req, res) =>
  res.sendFile(__dirname + '/public/admin.html')
);
app.get('/declarator.html', authorizeRoles('declarator'), (req, res) =>
  res.sendFile(__dirname + '/public/declarator.html')
);
app.get('/players/player.html', authorizeRoles('player'), (req, res) =>
  res.sendFile(__dirname + '/public/player.html')
);
app.get('/summary.html', authorizeRoles('admin'), (req, res) =>
  res.sendFile(__dirname + '/public/summary.html')
);
app.get('/wallet-logs.html', authorizeRoles('admin','master_agent', 'sub_agent', 'agent'), (req, res) =>
  res.sendFile(__dirname + '/public/wallet-logs.html')
);
app.get('/commission-logs.html', authorizeRoles('admin'), (req, res) =>
  res.sendFile(__dirname + '/public/commission-logs.html')
);
app.get('/withdrawal.html', authorizeRoles('admin','master_agent', 'sub_agent', 'agent'), (req, res) =>
  res.sendFile(__dirname + '/public/withdrawal.html')
);
app.get('/archives.html', authorizeRoles('admin'), (req, res) =>
  res.sendFile(__dirname + '/public/archives.html')
);
app.get('/agents.html', authorizeRoles('admin','master_agent', 'sub_agent', 'agent'), (req, res) =>
  res.sendFile(__dirname + '/public/agents.html')
);
app.get('/players.html', authorizeRoles('admin','master_agent', 'sub_agent', 'agent'), (req, res) =>
  res.sendFile(__dirname + '/public/players.html')
);
app.get('/pending.html', authorizeRoles('admin','master_agent', 'sub_agent', 'agent'), (req, res) =>
  res.sendFile(__dirname + '/public/pending.html')
);
app.get('/account.html', authorizeRoles('admin'), (req, res) =>
  res.sendFile(__dirname + '/public/account.html')
);
app.get('/change-password.html', authorizeRoles('admin','master_agent', 'sub_agent', 'agent','declarator','player'), (req, res) =>
  res.sendFile(__dirname + '/public/change-password.html')
);






// ==========================
// LOGOUT
// ==========================
app.get('/api/logout', async (req, res) => {
  if (req.session.user) {
    await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2',
      ['offline', req.session.user.id]
    );
  }

  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ==========================
// STATIC FILES
// ==========================
app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));



// ==========================
// DASHBOARD API (FIXED)
// ==========================
app.get('/api/dashboard', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(
      'SELECT id, username, role FROM users WHERE id=$1',
      [userId]
    );

    res.json({
      username: result.rows[0].username,
      role: result.rows[0].role,
      id: result.rows[0].id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// SIGNUP ROUTE (NEW)
// ==========================

app.post('/api/signup', async (req, res) => {
  const { username, password, parent_id } = req.body;

  try {
    // Check if username exists
    const check = await pool.query(
      'SELECT * FROM users WHERE username=$1',
      [username]
    );

    if (check.rows.length > 0) {
      return res.status(400).json({ error: "Username already exists" });
    }

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    // Insert user
    await pool.query(`
      INSERT INTO users 
      (username, password, role, parent_id, status, failed_logins)
      VALUES ($1, $2, $3, $4, $5, 0)
    `, [
      username,
      hashed,
      'player',               // default role
      parent_id || null,
      'pending'               // 🔥 requires approval
    ]);

    res.json({ message: "User created" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// PENDING COUNT API
// ==========================
app.get('/api/pending-count', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(
      'SELECT COUNT(*) FROM users WHERE parent_id = $1 AND status = $2',
      [userId, 'pending']
    );

    res.json({
      count: parseInt(result.rows[0].count)
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// wallet CONTROLLER
// ==========================
const { addTransaction, getBalance, getTransactions } = require('./controllers/wallet');

// Example API using the imported functions
app.get('/api/wallet/:userId', isAuthenticated, async (req, res) => {
    try {
        const balance = await getBalance(req.params.userId);
        if (balance === null) return res.status(404).json({ error: "User not found" });
        res.json({ balance });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

app.get('/api/wallet/:userId/transactions', isAuthenticated, async (req, res) => {
    try {
        const transactions = await getTransactions(req.params.userId);
        res.json(transactions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

const { getDashboardWallets } = require('./controllers/wallet');

app.get('/api/dashboard-wallets', isAuthenticated, async (req, res) => {
    try {
        const data = await getDashboardWallets(req.session.user.id);
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// ==========================
// CHANGE PASSWORD API
// ==========================
app.post('/api/change-password', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const { currentPassword, newPassword } = req.body;

  try {
    // Get user
    const result = await pool.query(
      'SELECT password FROM users WHERE id=$1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    // Check current password
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // 🔐 Password restrictions
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    // Hash new password
    const hashed = await bcrypt.hash(newPassword, 10);

    // Update password
    await pool.query(
      'UPDATE users SET password=$1 WHERE id=$2',
      [hashed, userId]
    );

    res.json({ message: "Password updated successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}); 
// ==========================
// PENDING USERS API
// ==========================
app.get('/api/pending-users', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(`
      SELECT id, username, role, created_at
      FROM users
      WHERE parent_id = $1 AND status = 'pending'
      ORDER BY created_at DESC
    `, [userId]);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// APPROVE USER API
// ==========================
app.post('/api/approve-user', isAuthenticated, async (req, res) => {
  const { userId, role } = req.body;

  try {
    await pool.query(`
      UPDATE users
      SET status = 'offline',
          role = $1,
          updated_at = NOW()
      WHERE id = $2
    `, [role, userId]);

    res.json({ message: "User approved" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// REJECT USER API
// ==========================
app.post('/api/reject-user', isAuthenticated, async (req, res) => {
  const { userId } = req.body;

  try {
    await pool.query(`
      UPDATE users
      SET status = 'rejected',
          updated_at = NOW()
      WHERE id = $1
    `, [userId]);

    res.json({ message: "User rejected" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// PLAYERS LIST API
// ==========================
app.get('/api/players', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(`
      SELECT u.id, u.username, u.points, u.status, u.role, u.parent_id,
             p.username AS parent_username
      FROM users u
      LEFT JOIN users p ON u.parent_id = p.id
      WHERE u.role = 'player'
      AND u.status NOT IN ('pending', 'rejected')
      AND (u.parent_id = $1 OR p.parent_id = $1 OR p.id = $1)
      ORDER BY u.created_at DESC
    `, [userId]);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// ADD POINTS API (ADMIN ONLY)
// ==========================
app.post('/api/add-points', isAuthenticated, async (req, res) => {
  const { userId, amount } = req.body;
  const currentUserId = req.session.user.id;
  try{
    // prevent self-transfer
    if (Number(userId) === Number(currentUserId)) {
      return res.status(400).json({ error: "Invalid action" });
    }
  }
  catch(err){
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
  try {
    const pointsToTransfer = Number(amount);

    if (!pointsToTransfer || pointsToTransfer <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // 🔍 Get player
    const playerRes = await pool.query(
      'SELECT parent_id, points, role, username FROM users WHERE id = $1',
      [userId]
    );

    if (playerRes.rows.length === 0) {
      return res.status(404).json({ error: "Player not found" });
    }

    const player = playerRes.rows[0];
    
    const agentRes = await pool.query(
      'SELECT points, username FROM users WHERE id = $1',
      [currentUserId]
    );
    // 🔐 Only direct parent
    if (Number(player.parent_id) !== Number(currentUserId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    

    const agentPoints = Number(agentRes.rows[0].points);

    // ❌ Insufficient balance
    if (agentPoints < pointsToTransfer) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // =========================
    // 🔁 START TRANSACTION
    // =========================
    await pool.query('BEGIN');

    // ➖ Deduct from agent
    const newAgentBalance = agentPoints - pointsToTransfer;

    await pool.query(`
      UPDATE users SET points = $1 WHERE id = $2
    `, [newAgentBalance, currentUserId]);

    // ➕ Add to player
    const newPlayerBalance = Number(player.points) + pointsToTransfer;

    await pool.query(`
      UPDATE users SET points = $1 WHERE id = $2
    `, [newPlayerBalance, userId]);

    
    // 📝 Log agent (DEBIT)
    await pool.query(`
      INSERT INTO wallet_transactions 
      (user_id, type, amount, balance_after, description)
      VALUES ($1, 'debit', $2, $3, $4)
    `, [
      currentUserId,
      pointsToTransfer,
      newAgentBalance,
      `Transferred to player ID ${player.username})`
    ]);

    // 📝 Log player (CREDIT)
    await pool.query(`
      INSERT INTO wallet_transactions 
      (user_id, type, amount, balance_after, description)
      VALUES ($1, 'credit', $2, $3, $4)
    `, [
      userId,
      pointsToTransfer,
      newPlayerBalance,
      `Received from ${agentRes.rows[0].username}`
    ]);

    await pool.query('COMMIT');

    res.json({ message: "Points transferred successfully" });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: "Transaction failed" });
  }
});
// ==========================
// UPDATE STATUS API (ADMIN ONLY)
// ==========================
app.post('/api/update-status', isAuthenticated, async (req, res) => {
  const { userId, status } = req.body;

  try {
    await pool.query(`
      UPDATE users SET status = $1, updated_at = NOW()
      WHERE id = $2
    `, [status, userId]);

    res.json({ message: "Status updated" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// RESET PASSWORD API (ADMIN ONLY)
// ==========================
app.post('/api/reset-password', isAuthenticated, async (req, res) => {
  const { userId } = req.body;

  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const hashed = await bcrypt.hash('123456', 10);

    await pool.query(`
      UPDATE users SET password = $1, updated_at = NOW()
      WHERE id = $2
    `, [hashed, userId]);

    res.json({ message: "Password reset to 123456" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// AGENTS LIST API
// ==========================
app.get('/api/agents', isAuthenticated, async (req, res) => {
  try {
    const currentUserId = req.session.user.id;

    const result = await pool.query(`
      SELECT 
        u.id,
        u.username,
        u.role,
        u.points,
        u.status,
        u.parent_id,
        u.commission_rate,
        u.commission_earnings,
        p.username AS parent_username
      FROM users u
      LEFT JOIN users p ON u.parent_id = p.id
      WHERE u.role IN ('master_agent', 'sub_agent', 'agent')
      AND u.status NOT IN ('pending', 'rejected')
    `);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// UPDATE COMMISSION API (ADMIN ONLY)
// ==========================
app.post('/api/update-commission', isAuthenticated, async (req, res) => {
  const { userId, rate } = req.body;
  const currentUserId = req.session.user.id;

  try {
    // Get agent
    const agentRes = await pool.query(
      'SELECT parent_id FROM users WHERE id=$1',
      [userId]
    );

    if (agentRes.rows.length === 0) {
      return res.status(404).json({ error: "Agent not found" });
    }

    if (Number(agentRes.rows[0].parent_id) !== Number(currentUserId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    // Get current user's commission
    const currentUser = await pool.query(
      'SELECT commission_rate FROM users WHERE id=$1',
      [currentUserId]
    );

    const maxAllowed = (currentUser.rows[0].commission_rate || 0) - 1;

    if (rate < 0 || rate > maxAllowed) {
      return res.status(400).json({ error: "Invalid commission rate" });
    }

    await pool.query(
      'UPDATE users SET commission_rate=$1 WHERE id=$2',
      [rate, userId]
    );

    res.json({ message: "Commission updated" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// CONVERT COMMISSION API (ADMIN ONLY)
// ==========================
app.post('/api/convert-commission', isAuthenticated, async (req, res) => {
  const { userId, amount } = req.body;
  const currentUserId = req.session.user.id;

  try {
    const user = await pool.query(
      'SELECT commission_earnings, parent_id FROM users WHERE id=$1',
      [userId]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    if (Number(user.rows[0].parent_id) !== Number(currentUserId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const available = Number(user.rows[0].commission_earnings);

    if (amount <= 0 || amount > available) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    await pool.query('BEGIN');

    await pool.query(
      'UPDATE users SET points = points + $1, commission_earnings = commission_earnings - $1 WHERE id=$2',
      [amount, userId]
    );

    await pool.query('COMMIT');

    res.json({ message: "Commission converted" });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// WITHDRAW COMMISSION API (ADMIN ONLY)
// ==========================
app.post('/api/withdraw-points', isAuthenticated, async (req, res) => {
  const { userId, amount } = req.body;
  const currentUserId = req.session.user.id;

  try {
    const user = await pool.query(
      'SELECT points, parent_id FROM users WHERE id=$1',
      [userId]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    if (Number(user.rows[0].parent_id) !== Number(currentUserId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const available = Number(user.rows[0].points);
    const parentId = user.rows[0].parent_id;

    if (amount <= 0 || amount > available) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    await pool.query('BEGIN');

    // ➖ Deduct from agent POINTS
    await pool.query(
      'UPDATE users SET points = points - $1 WHERE id=$2',
      [amount, userId]
    );

    // ➕ Add to parent POINTS
    await pool.query(
      'UPDATE users SET points = points + $1 WHERE id=$2',
      [amount, parentId]
    );

    await pool.query('COMMIT');

    res.json({ message: "Points withdrawn successfully" });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// MY WALLET TRANSACTIONS API
// ==========================

app.get('/api/my-wallet-transactions', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(`
      SELECT id, type, amount, balance_after, description, reference_id, created_at
      FROM wallet_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// PLACE BET API
// ==========================
app.post('/api/place-bet', isAuthenticated, async (req, res) => {

    const userId = req.session.user.id;
    const { side, amount } = req.body;

    try {
        const result = await placeBet(userId, side, Number(amount));
        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message });
    }
});

// ==========================
// GAME STATUS API (🔥 REQUIRED)
// ==========================
app.get('/api/game-status', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // ✅ 1. GET THE LATEST GAME
        const gameRes = await pool.query(
            `SELECT * FROM games ORDER BY created_at DESC LIMIT 1;`
        );

        if (gameRes.rows.length === 0) {
            return res.json({
                fightNumber: 0,
                status: "CLOSED",
                totalMeron: 0,
                totalWala: 0,
                totalDraw: 0,
                myMeron: 0,
                myWala: 0,
                myDraw: 0
            });
        }

        const game = gameRes.rows[0];

        // ✅ 2. GET TOTAL BETS
        const totalsRes = await pool.query(`
            SELECT
                COALESCE(SUM(CASE WHEN side='MERON' THEN amount END),0) AS "totalMeron",
                COALESCE(SUM(CASE WHEN side='WALA' THEN amount END),0) AS "totalWala",
                COALESCE(SUM(CASE WHEN side='DRAW' THEN amount END),0) AS "totalDraw"
            FROM bets
            WHERE game_id = $1
        `, [game.id]);

        const totals = totalsRes.rows[0];

        // ✅ 3. GET USER BETS
        const myRes = await pool.query(`
            SELECT
                COALESCE(SUM(CASE WHEN side='MERON' THEN amount END),0) AS "myMeron",
                COALESCE(SUM(CASE WHEN side='WALA' THEN amount END),0) AS "myWala",
                COALESCE(SUM(CASE WHEN side='DRAW' THEN amount END),0) AS "myDraw"
            FROM bets
            WHERE game_id = $1 AND user_id = $2
        `, [game.id, userId]);

        const my = myRes.rows[0];
        
        // ✅ 3. GET PLAYER BETS
        const playerRes = await pool.query(`
            SELECT
                COALESCE(SUM(CASE WHEN side='MERON' THEN amount END),0) AS "playerMeron",
                COALESCE(SUM(CASE WHEN side='WALA' THEN amount END),0) AS "playerWala",
                COALESCE(SUM(CASE WHEN side='DRAW' THEN amount END),0) AS "playerDraw"
            FROM bets
            WHERE game_id = $1 AND is_dummy = false
        `, [game.id]);

        const playerBets = playerRes.rows[0];

        // ✅ 4. RETURN DATA
        res.json({
            fightNumber: game.fight_number,
            status: game.status,
            totalMeron: Number(totals.totalMeron),
            totalWala: Number(totals.totalWala),
            totalDraw: Number(totals.totalDraw),
            myMeron: Number(my.myMeron),
            myWala: Number(my.myWala),
            myDraw: Number(my.myDraw),
            playerMeron: Number(playerBets.playerMeron),
            playerWala: Number(playerBets.playerWala),
            playerDraw: Number(playerBets.playerDraw)
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// ==========================
// WITHDRAW REQUEST API
// ==========================
app.post('/api/withdraw-request', isAuthenticated, async (req, res) => {
    const userId = req.session.user.id;
    const { amount } = req.body;
    const pending = await pool.query(`
        SELECT * FROM withdrawal_requests
        WHERE requester_id=$1 AND status='pending'
    `, [userId]);

    if (pending.rows.length > 0) {
        return res.status(400).json({ error: "You already have a pending request" });
    }
    try {
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        // 🔍 Get user + parent (approver)
        const userRes = await pool.query(
            'SELECT parent_id, points FROM users WHERE id=$1',
            [userId]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userRes.rows[0];

        if (amount > user.points) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // 📝 Insert withdrawal request
        await pool.query(`
            INSERT INTO withdrawal_requests
            (requester_id, approver_id, points)
            VALUES ($1, $2, $3)
        `, [
            userId,
            user.parent_id, // agent approves
            amount
        ]);

        res.json({ message: "Request submitted" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// ==========================
// WITHDRAWAL COUNT API
// ==========================
app.get('/api/withdrawal-count', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(`
      SELECT COUNT(*) 
      FROM withdrawal_requests
      WHERE approver_id = $1 AND status = 'pending'
    `, [userId]);

    res.json({
      count: parseInt(result.rows[0].count)
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// WITHDRAWAL REQUESTS API
// ==========================
app.get('/api/withdrawal-requests', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(`
      SELECT wr.id, wr.points, wr.created_at,
             u.username
      FROM withdrawal_requests wr
      JOIN users u ON u.id = wr.requester_id
      WHERE wr.approver_id = $1
      AND wr.status = 'pending'
      ORDER BY wr.created_at DESC
    `, [userId]);

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// APPROVE WITHDRAWAL API
// ==========================
app.post('/api/approve-withdrawal', isAuthenticated, async (req, res) => {
  const { id } = req.body;

  try {
    const approverId = req.session.user.id;

    // 🔍 Get request
    const reqRes = await pool.query(`
      SELECT * FROM withdrawal_requests WHERE id = $1
    `, [id]);

    if (reqRes.rows.length === 0) {
      return res.status(404).json({ error: "Request not found" });
    }

    const request = reqRes.rows[0];

    if (request.approver_id !== approverId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: "Already processed" });
    }

    const amount = Number(request.points);

    // 🔍 Get balances
    const requester = await pool.query(
      'SELECT points, username FROM users WHERE id=$1',
      [request.requester_id]
    );

    const approver = await pool.query(
      'SELECT points FROM users WHERE id=$1',
      [approverId]
    );

    if (requester.rows[0].points < amount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const newRequesterBalance = Number(requester.rows[0].points) - amount;
    const newApproverBalance = Number(approver.rows[0].points) + amount;

    // =========================
    // 🔁 TRANSACTION
    // =========================
    await pool.query('BEGIN');

    // ➖ Deduct requester
    await pool.query(
      'UPDATE users SET points=$1 WHERE id=$2',
      [newRequesterBalance, request.requester_id]
    );

    // ➕ Add to approver
    await pool.query(
      'UPDATE users SET points=$1 WHERE id=$2',
      [newApproverBalance, approverId]
    );

    // 📝 Wallet logs
    await pool.query(`
      INSERT INTO wallet_transactions 
      (user_id, type, amount, balance_after, description)
      VALUES ($1,'debit',$2,$3,$4)
    `, [
      request.requester_id,
      amount,
      newRequesterBalance,
      `Withdrawal approved`
    ]);

    await pool.query(`
      INSERT INTO wallet_transactions 
      (user_id, type, amount, balance_after, description)
      VALUES ($1,'credit',$2,$3,$4)
    `, [
      approverId,
      amount,
      newApproverBalance,
      `Received withdrawal`
    ]);

    // ✅ Update request
    await pool.query(`
      UPDATE withdrawal_requests
      SET status='approved', updated_at=NOW()
      WHERE id=$1
    `, [id]);

    await pool.query('COMMIT');

    res.json({ message: "Approved" });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: "Transaction failed" });
  }
});

// ==========================
// REJECT WITHDRAWAL API
// ==========================
app.post('/api/reject-withdrawal', isAuthenticated, async (req, res) => {
  const { id } = req.body;

  try {
    await pool.query(`
      UPDATE withdrawal_requests
      SET status='rejected', updated_at=NOW()
      WHERE id=$1
    `, [id]);

    res.json({ message: "Rejected" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
//  START GAME (DECLARATOR ONLY)
// ==========================
app.post('/api/start-game', isAuthenticated, async (req, res) => {
  const { fightNumber } = req.body;

  try {
    if (req.session.user.role !== 'declarator') {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // close any existing open game first (safety)
    await pool.query(`
      UPDATE games SET status='CLOSED'
      WHERE status='OPEN'
    `);

    const result = await pool.query(`
      INSERT INTO games (fight_number, status)
      VALUES ($1, 'OPEN')
      RETURNING *
    `, [fightNumber]);

    await upsertActiveEvent({
      gameId: result.rows[0].id,
      event_name: "",
      announcement: `Game Started - Fight #${fightNumber}`
    });

    res.json({
      message: "Game started",
      game: result.rows[0]
    });
    startDummyEngine(req.session.user.id);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
//  CLOSE GAME (DECLARATOR ONLY)
// ==========================

app.post('/api/close-game', isAuthenticated, async (req, res) => {
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
app.post('/api/declare-winner', isAuthenticated, async (req, res) => {
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
    await settleGame(gameId, winner);

    await upsertActiveEvent({
      gameId: gameId,
      event_name: "",
      announcement: `${winner} WINS!`,
    });

    res.json({
      message: "Winner declared",
      game: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
//  ACTIVE EVENT API
// ==========================
app.get('/api/active-event', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT event_name, announcement
      FROM active_event
      WHERE id = 1
    `);

    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
//  SET HEADER API (DECLARATOR ONLY)
// ==========================
app.post('/api/declarator/set-header', isAuthenticated, async (req, res) => {
  const { message } = req.body;

  try {
    await pool.query(`
      UPDATE active_event
      SET announcement = $1, updated_at = NOW()
      WHERE id = 1
    `, [message]);

    res.json({ message: "Header updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
//  SET EVENT NAME API (DECLARATOR ONLY)
// ==========================
app.post('/api/declarator/set-event-name', isAuthenticated, async (req, res) => {
  const { event_name } = req.body;

  try {
    await pool.query(`
      UPDATE active_event
      SET event_name = $1, updated_at = NOW()
      WHERE id = 1
    `, [event_name]);

    res.json({ message: "Event name updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// SET EVENT NAME API (DECLARATOR ONLY)
// ==========================
app.post('/api/declarator/set-event', isAuthenticated, async (req, res) => {
  const { event_name } = req.body;

  try {
    await pool.query(`
      UPDATE active_event
      SET event_name = $1, updated_at = NOW()
      WHERE id = 1
    `, [event_name]);

    res.json({ message: "Event updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// TOGGLE STREAM API (DECLARATOR ONLY)
// ==========================
app.post('/api/declarator/toggle-stream', isAuthenticated, async (req, res) => {
  try {
    if (req.session.user.role !== 'declarator') {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { enabled } = req.body;

    await pool.query(`
      UPDATE active_event
      SET stream_enabled = $1,
          updated_at = NOW()
      WHERE id = 1
    `, [enabled]);

    res.json({ message: "Stream updated" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
