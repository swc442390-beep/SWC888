const session = require('express-session');
const express = require('express');
const cors = require('cors');
const pool = require('./db/connection');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json());
app.use(session({
  secret: 'secret-key', // you can change later
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // true only if HTTPS
}));

/* =========================
   TEST ROUTE
========================= */
app.get('/api/test', (req, res) => {
  res.json({ message: "Server working" });
});

/* =========================
   LOGIN API (CONNECTED TO DB)
========================= */
app.post('/api/login', async (req, res) => {
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

    if (password !== user.password) {
      return res.status(401).json({ error: "Wrong password" });
    }

    // ✅ SAVE SESSION
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role
    };

    // ✅ UPDATE DATABASE (ONLINE)
    await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2',
      ['online', user.id]
    );

    res.json({
      message: "Login success",
      role: user.role
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   SERVE FRONTEND
========================= */
app.use(express.static('public'));

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));

/* =========================
   PROTECT ADMIN PAGE
========================= */
app.get('/admin.html', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }
  res.sendFile(__dirname + '/public/admin.html');
});

/* =========================
   LOGOUT API
========================= */
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