// ==========================
// IMPORTS
// ==========================
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const pool = require('./db/connection');
const bcrypt = require('bcrypt');
const helmet = require('helmet');

const allowedOrigin = 'https://letsplay-famw.onrender.com';
const app = express();

// ==========================
// SECURITY MIDDLEWARE
// ==========================
app.use(helmet());
app.use(cors({
  origin: allowedOrigin,   // your deployed site
  credentials: true        // allow cookies
}));
app.use(express.json());

// Prevent caching (important after logout)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ==========================
// SESSION CONFIG
// ==========================
app.use(session({
  secret: 'secret-key', // change in production
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,        // true if HTTPS
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 30 // 30 min
  }
}));

// ==========================
// AUTH MIDDLEWARE
// ==========================
function isAuthenticated(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ==========================
// ROLE AUTHORIZATION
// ==========================
function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/');
    if (!roles.includes(req.session.user.role)) return res.status(403).send("Forbidden");
    next();
  };
}

// ==========================
// LOGIN ROUTE
// ==========================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: "User not found" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Wrong password" });

    // Save session
    req.session.user = { id: user.id, username: user.username, role: user.role };

    // Update status
    await pool.query('UPDATE users SET status=$1 WHERE id=$2', ['online', user.id]);

    res.json({ message: "Login success", role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// ROLE-PROTECTED PAGES
// ==========================
app.get('/admin.html', authorizeRoles('admin'), (req, res) => res.sendFile(__dirname + '/public/admin.html'));
app.get('/agent.html', authorizeRoles('master_agent','sub_agent','agent'), (req, res) => res.sendFile(__dirname + '/public/agent.html'));
app.get('/declarator.html', authorizeRoles('declarator'), (req, res) => res.sendFile(__dirname + '/public/declarator.html'));
app.get('/player.html', authorizeRoles('player'), (req, res) => res.sendFile(__dirname + '/public/player.html'));

// ==========================
// DASHBOARD API
// ==========================
app.get('/api/dashboard', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userResult = await pool.query('SELECT points, role FROM users WHERE id=$1', [userId]);
    const agentsResult = await pool.query('SELECT COUNT(*) FROM users WHERE parent_id=$1 AND role=$2', [userId,'agent']);
    const playersResult = await pool.query('SELECT COUNT(*) FROM users WHERE parent_id=$1 AND role=$2', [userId,'player']);

    res.json({
      username: req.session.user.username,
      points: userResult.rows[0].points,
      role: userResult.rows[0].role,
      agentsCount: parseInt(agentsResult.rows[0].count),
      playersCount: parseInt(playersResult.rows[0].count)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// LOGOUT
// ==========================
app.get('/api/logout', async (req, res) => {
  if (req.session.user) await pool.query('UPDATE users SET status=$1 WHERE id=$2', ['offline', req.session.user.id]);
  req.session.destroy(() => res.redirect('/'));
});

// ==========================
// CREATE USER (ADMIN ONLY)
// ==========================
app.post('/api/create-user', isAuthenticated, async (req, res) => {
  const { username, password, role, parent_id } = req.body;
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username,password,role,parent_id,points,can_withdraw,status)
       VALUES ($1,$2,$3,$4,0,false,'offline')`,
      [username, hashedPassword, role, parent_id || null]
    );
    res.json({ message: "User created successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creating user" });
  }
});

// ==========================
// STATIC FILES
// ==========================
app.use(express.static('public', { 
  setHeaders: (res, path) => { 
    if(path.endsWith('.html')) res.setHeader('Cache-Control','no-store'); 
  }
}));

// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));