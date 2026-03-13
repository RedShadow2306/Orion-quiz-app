require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    host: process.env.DB_HOST,
    port: 5432,
    database: 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

// ── TEST ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ message: '🚀 Orion API is running!' });
});

// ── QUIZZES ───────────────────────────────────────────────────────────────────

// Create a quiz
app.post('/quizzes', async (req, res) => {
    const { host_id, title, description } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO quizzes (host_id, title, description) VALUES ($1, $2, $3) RETURNING *',
            [host_id, title, description]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── QUESTIONS (NEW) ───────────────────────────────────────────────────────────

// Save all questions + options for a quiz in one go
app.post('/questions/bulk', async (req, res) => {
    const { quiz_id, questions } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];

            // Insert the question
            const qResult = await client.query(
                `INSERT INTO questions (quiz_id, question_text, question_type, time_limit_seconds, points, order_num)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [quiz_id, q.question_text, q.question_type, q.time_limit_seconds || 30, q.points || 10, i + 1]
            );
            const question = qResult.rows[0];

            // Insert options if MCQ or poll
            if (q.question_type !== 'open_ended' && q.options) {
                for (const opt of q.options) {
                    if (opt.text && opt.text.trim()) {
                        await client.query(
                            'INSERT INTO options (question_id, option_text, is_correct) VALUES ($1, $2, $3)',
                            [question.question_id, opt.text.trim(), opt.is_correct || false]
                        );
                    }
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ── SESSIONS ──────────────────────────────────────────────────────────────────

// Create a session
app.post('/sessions', async (req, res) => {
    const { quiz_id, join_code } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO quiz_sessions (quiz_id, join_code) VALUES ($1, $2) RETURNING *',
            [quiz_id, join_code]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get session by join code
app.get('/sessions/:join_code', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM quiz_sessions WHERE join_code = $1',
            [req.params.join_code]
        );
        if (result.rows.length === 0)
            return res.status(404).json({ error: 'Session not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── JOIN SESSION (NEW) ────────────────────────────────────────────────────────

// Player joins: creates a guest user + registers them in session
app.post('/join-session', async (req, res) => {
    const { username, join_code } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Find the session
        const sessionResult = await client.query(
            'SELECT * FROM quiz_sessions WHERE join_code = $1',
            [join_code]
        );
        if (sessionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Quiz code not found!' });
        }
        const session = sessionResult.rows[0];

        // 2. Create a guest user with unique email
        const guestEmail = `${username.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}@guest.orion`;
        const userResult = await client.query(
            `INSERT INTO users (username, email, password_hash, role)
             VALUES ($1, $2, 'guest', 'participant') RETURNING *`,
            [username, guestEmail]
        );
        const user = userResult.rows[0];

        // 3. Register participant in session
        await client.query(
            'INSERT INTO session_participants (session_id, user_id) VALUES ($1, $2)',
            [session.session_id, user.user_id]
        );

        await client.query('COMMIT');
        res.json({
            success: true,
            user_id: user.user_id,
            username: user.username,
            session_id: session.session_id,
            join_code
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ── QUESTIONS FOR PLAY (NEW) ──────────────────────────────────────────────────

// Get all questions + options for a session (used by play.html)
app.get('/sessions/:join_code/questions', async (req, res) => {
    try {
        const sessionResult = await pool.query(
            'SELECT * FROM quiz_sessions WHERE join_code = $1',
            [req.params.join_code]
        );
        if (sessionResult.rows.length === 0)
            return res.status(404).json({ error: 'Session not found' });

        const session = sessionResult.rows[0];

        const qResult = await pool.query(
            'SELECT * FROM questions WHERE quiz_id = $1 ORDER BY order_num',
            [session.quiz_id]
        );

        // Attach options to each question
        const questions = [];
        for (const q of qResult.rows) {
            const optResult = await pool.query(
                'SELECT * FROM options WHERE question_id = $1',
                [q.question_id]
            );
            questions.push({ ...q, options: optResult.rows });
        }

        res.json({ session, questions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── RESPONSES / SCORING (NEW) ─────────────────────────────────────────────────

// Submit an answer for a question
app.post('/responses', async (req, res) => {
    const { session_id, question_id, user_id, option_id, open_answer } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get question to know type + points
        const qResult = await client.query(
            'SELECT * FROM questions WHERE question_id = $1',
            [question_id]
        );
        const question = qResult.rows[0];

        let is_correct = null;
        let score_awarded = 0;

        if (question.question_type === 'mcq' && option_id) {
            const optResult = await client.query(
                'SELECT is_correct FROM options WHERE option_id = $1',
                [option_id]
            );
            is_correct = optResult.rows[0]?.is_correct || false;
            score_awarded = is_correct ? (question.points || 10) : 0;
        }
        // polls and open_ended: no scoring

        // Save the response
        await client.query(
            `INSERT INTO responses (session_id, question_id, user_id, option_id, open_answer, is_correct, score_awarded)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [session_id, question_id, user_id, option_id || null, open_answer || null, is_correct, score_awarded]
        );

        // Update participant's total score
        await client.query(
            `UPDATE session_participants SET total_score = total_score + $1
             WHERE session_id = $2 AND user_id = $3`,
            [score_awarded, session_id, user_id]
        );

        await client.query('COMMIT');
        res.json({ success: true, is_correct, score_awarded });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ── LEADERBOARD ───────────────────────────────────────────────────────────────

// By session_id
app.get('/leaderboard/:session_id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.username, sp.total_score
             FROM session_participants sp
             JOIN users u ON u.user_id = sp.user_id
             WHERE sp.session_id = $1
             ORDER BY sp.total_score DESC`,
            [req.params.session_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// By join code (used by leaderboard.html)
app.get('/leaderboard/by-code/:join_code', async (req, res) => {
    try {
        const sessionResult = await pool.query(
            'SELECT session_id FROM quiz_sessions WHERE join_code = $1',
            [req.params.join_code]
        );
        if (sessionResult.rows.length === 0)
            return res.status(404).json({ error: 'Session not found' });

        const session_id = sessionResult.rows[0].session_id;
        const result = await pool.query(
            `SELECT u.username, sp.total_score
             FROM session_participants sp
             JOIN users u ON u.user_id = sp.user_id
             WHERE sp.session_id = $1
             ORDER BY sp.total_score DESC`,
            [session_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Get session status + participant count
app.get('/sessions/:join_code/status', async (req, res) => {
    try {
        const sessionResult = await pool.query(
            'SELECT * FROM quiz_sessions WHERE join_code = $1',
            [req.params.join_code]
        );
        if (sessionResult.rows.length === 0)
            return res.status(404).json({ error: 'Session not found' });
        
        const session = sessionResult.rows[0];
        const countResult = await pool.query(
            'SELECT COUNT(*) FROM session_participants WHERE session_id = $1',
            [session.session_id]
        );
        
        res.json({
            status: session.status,
            participant_count: parseInt(countResult.rows[0].count)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start a session (host clicks Start Quiz)
app.post('/sessions/:join_code/start', async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE quiz_sessions SET status = 'active', started_at = NOW()
             WHERE join_code = $1 RETURNING *`,
            [req.params.join_code]
        );
        if (result.rows.length === 0)
            return res.status(404).json({ error: 'Session not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download quiz results as CSV
app.get('/results/:join_code', async (req, res) => {
    try {
        const sessionResult = await pool.query(
            'SELECT * FROM quiz_sessions WHERE join_code = $1',
            [req.params.join_code]
        );
        if (sessionResult.rows.length === 0)
            return res.status(404).json({ error: 'Session not found' });

        const session = sessionResult.rows[0];

        // Get all questions for this quiz
        const questionsResult = await pool.query(
            'SELECT * FROM questions WHERE quiz_id = $1 ORDER BY order_num',
            [session.quiz_id]
        );
        const questions = questionsResult.rows;

        // Get all participants with scores
        const participantsResult = await pool.query(
            `SELECT u.username, sp.total_score, sp.user_id,
             RANK() OVER (ORDER BY sp.total_score DESC) as rank
             FROM session_participants sp
             JOIN users u ON u.user_id = sp.user_id
             WHERE sp.session_id = $1
             ORDER BY sp.total_score DESC`,
            [session.session_id]
        );
        const participants = participantsResult.rows;

        // Get all responses
        const responsesResult = await pool.query(
            `SELECT r.user_id, r.question_id, r.is_correct, r.score_awarded,
             r.open_answer, o.option_text as selected_option
             FROM responses r
             LEFT JOIN options o ON o.option_id = r.option_id
             WHERE r.session_id = $1`,
            [session.session_id]
        );
        const responses = responsesResult.rows;

        // Build CSV
        const quizResult = await pool.query(
            'SELECT title FROM quizzes WHERE quiz_id = $1',
            [session.quiz_id]
        );
        const quizTitle = quizResult.rows[0]?.title || 'Quiz';

        // Header row
        let csv = `Quiz: ${quizTitle}\n`;
        csv += `Join Code: ${req.params.join_code}\n`;
        csv += `Total Participants: ${participants.length}\n\n`;

        // Column headers
        const questionHeaders = questions.map((q, i) => `Q${i+1}: ${q.question_text.substring(0, 30)}...`).join(',');
        csv += `Rank,Player Name,Total Score,${questionHeaders}\n`;

        // Data rows
        for (const p of participants) {
            const playerResponses = responses.filter(r => r.user_id === p.user_id);
            const questionData = questions.map(q => {
                const response = playerResponses.find(r => r.question_id === q.question_id);
                if (!response) return 'No Answer';
                if (q.question_type === 'open_ended') return response.open_answer || 'No Answer';
                return `${response.selected_option || 'No Answer'} (${response.is_correct ? '✓' : '✗'})`;
            }).join(',');

            csv += `${p.rank},${p.username},${p.total_score},${questionData}\n`;
        }

        // Send as downloadable file
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="orion-results-${req.params.join_code}.csv"`);
        res.send(csv);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Orion server running on port ${PORT}`));