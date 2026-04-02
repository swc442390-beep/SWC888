const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Test route
app.get('/api/test', (req, res) => {
  res.json({ message: "Server working" });
});

// Serve frontend (HTML pages)
app.use(express.static('public'));

// Database connection (optional now)
const pool = require('./db/connection');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));