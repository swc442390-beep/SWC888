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
// MIDDLEWARE
// ==========================
app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));

app.use(express.json());

app.use(express.static('public'));
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
        id: user.id
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
app.get('/admin.html', authorizeRoles('admin'), (req, res) =>
  res.sendFile(__dirname + '/public/admin.html')
);

app.get('/agent.html', authorizeRoles('master_agent', 'sub_agent', 'agent'), (req, res) =>
  res.sendFile(__dirname + '/public/agent.html')
);

app.get('/declarator.html', authorizeRoles('declarator'), (req, res) =>
  res.sendFile(__dirname + '/public/declarator.html')
);

app.get('/player.html', authorizeRoles('player'), (req, res) =>
  res.sendFile(__dirname + '/public/player.html')
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
// START SERVER
// ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ==========================
// DASHBOARD API (FIXED)
// ==========================
app.get('/api/dashboard', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(
      'SELECT username, role FROM users WHERE id=$1',
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