function buildTree(rows, rootId) {
    const map = {};
    let root = null;

    // create map
    rows.forEach(row => {
        map[row.id] = { ...row, children: [] };
    });

    // build hierarchy
    rows.forEach(row => {
        if (Number(row.id) === Number(rootId)) {
            root = map[row.id];
        } else if (row.parent_id && map[row.parent_id]) {
            map[row.parent_id].children.push(map[row.id]);
        }
    });

    return root;
}
router.get('/network-tree/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const result = await pool.query(`
            WITH RECURSIVE tree AS (
                SELECT id, username, role, parent_id
                FROM users
                WHERE id = $1

                UNION ALL

                SELECT u.id, u.username, u.role, u.parent_id
                FROM users u
                INNER JOIN tree t ON u.parent_id = t.id
            )
            SELECT * FROM tree;
        `, [userId]);

        const rows = result.rows;

        // 👉 convert flat list into nested tree
        const tree = buildTree(rows, userId);

        res.json(tree);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to load network" });
    }
});