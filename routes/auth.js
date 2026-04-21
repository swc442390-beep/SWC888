const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../db/connection');

// middleware
const isAuthenticated = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// ==========================
// LOGIN
// ==========================
router.post('/login', async (req, res) => {
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

    if (user.status === 'pending') {
      return res.status(403).json({ error: "Account pending approval." });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: "Account suspended." });
    }

    if (user.lock_until && new Date() < user.lock_until) {
      const minutesLeft = Math.ceil((new Date(user.lock_until) - new Date()) / 60000);
      return res.status(403).json({ error: `Locked. Try again in ${minutesLeft} min.` });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      let failedAttempts = user.failed_logins + 1;
      let lockUntil = null;

      if (failedAttempts >= 5) {
        lockUntil = new Date(Date.now() + 5 * 60 * 1000);
        failedAttempts = 0;
      }

      await pool.query(
        'UPDATE users SET failed_logins = $1, lock_until = $2 WHERE id = $3',
        [failedAttempts, lockUntil, user.id]
      );

      return res.status(401).json({ error: "Wrong password" });
    }

    await pool.query(
      'UPDATE users SET failed_logins = 0, lock_until = NULL, status = $1 WHERE id = $2',
      ['online', user.id]
    );

    req.session.user = { id: user.id, username: user.username, role: user.role };

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Session error" });

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
// SIGNUP
// ==========================
router.post('/signup', async (req, res) => {
  const { username, password, parent_id } = req.body;

  try {
    const check = await pool.query(
      'SELECT * FROM users WHERE username=$1',
      [username]
    );

    if (check.rows.length > 0) {
      return res.status(400).json({ error: "Username exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    await pool.query(`
      INSERT INTO users 
      (username, password, role, parent_id, status, failed_logins)
      VALUES ($1, $2, $3, $4, $5, 0)
    `, [
      username,
      hashed,
      'player',
      parent_id || null,
      'pending'
    ]);

    res.json({ message: "User created" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// LOGOUT
// ==========================
router.get('/logout', async (req, res) => {
  if (req.session.user) {
    await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2',
      ['offline', req.session.user.id]
    );
  }

  req.session.destroy(() => {
    res.json({ message: "Logged out" });
  });
});

// ==========================
// DASHBOARD
// ==========================
router.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(
      'SELECT id, username, role FROM users WHERE id=$1',
      [userId]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================
// CHANGE PASSWORD
// ==========================
router.post('/change-password', isAuthenticated, async (req, res) => {
  const userId = req.session.user.id;
  const { currentPassword, newPassword } = req.body;

  try {
    const result = await pool.query(
      'SELECT password FROM users WHERE id=$1',
      [userId]
    );

    const match = await bcrypt.compare(currentPassword, result.rows[0].password);

    if (!match) {
      return res.status(401).json({ error: "Wrong current password" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query(
      'UPDATE users SET password=$1 WHERE id=$2',
      [hashed, userId]
    );

    res.json({ message: "Password updated" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;