// server.js
require('dotenv').config(); // .env 파일 로드

const express = require('express');
const db = require('./db'); // db.js 모듈 임포트

const app = express();
app.use(express.json()); // JSON 형식의 요청 본문을 파싱하기 위함

// --- API 엔드포인트 예시 (CRUD) ---

// 1. 사용자 생성 (CREATE)
app.post('/users', async (req, res) => {
    const { name, email } = req.body;
    try {
        // SQL Injection 방지를 위해 파라미터화된 쿼리 사용 ($1, $2)
        const result = await db.query(
            'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
            [name, email]
        );
        res.status(201).json(result.rows[0]); // 생성된 사용자 정보 반환
    } catch (err) {
        if (err.code === '23505') { // PostgreSQL 에러 코드: UNIQUE 제약 조건 위반 (이메일 중복 등)
            res.status(409).json({ message: '이미 존재하는 이메일입니다.' });
        } else {
            console.error('사용자 생성 중 오류 발생:', err.stack);
            res.status(500).json({ message: '서버 오류로 사용자 생성에 실패했습니다.' });
        }
    }
});

// 2. 모든 사용자 조회 (READ All)
app.get('/users', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM users ORDER BY created_at DESC');
        res.json(result.rows); // 모든 사용자 목록 반환
    } catch (err) {
        console.error('사용자 조회 중 오류 발생:', err.stack);
        res.status(500).json({ message: '서버 오류로 사용자 조회에 실패했습니다.' });
    }
});

// 3. 특정 사용자 ID로 조회 (READ One)
app.get('/users/:id', async (req, res) => {
    const { id } = req.params; // URL 파라미터에서 ID 추출
    try {
        const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: '해당 ID의 사용자를 찾을 수 없습니다.' });
        }
        res.json(result.rows[0]); // 특정 사용자 정보 반환
    } catch (err) {
        console.error('특정 사용자 조회 중 오류 발생:', err.stack);
        res.status(500).json({ message: '서버 오류로 사용자 조회에 실패했습니다.' });
    }
});

// 4. 사용자 정보 업데이트 (UPDATE)
app.put('/users/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email } = req.body;
    try {
        const result = await db.query(
            'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING *',
            [name, email, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: '업데이트할 사용자를 찾을 수 없습니다.' });
        }
        res.json(result.rows[0]); // 업데이트된 사용자 정보 반환
    } catch (err) {
        if (err.code === '23505') {
            res.status(409).json({ message: '이미 존재하는 이메일입니다.' });
        } else {
            console.error('사용자 업데이트 중 오류 발생:', err.stack);
            res.status(500).json({ message: '서버 오류로 사용자 업데이트에 실패했습니다.' });
        }
    }
});

// 5. 사용자 삭제 (DELETE)
app.delete('/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: '삭제할 사용자를 찾을 수 없습니다.' });
        }
        res.json({ message: '사용자가 성공적으로 삭제되었습니다.', deletedUser: result.rows[0] });
    } catch (err) {
        console.error('사용자 삭제 중 오류 발생:', err.stack);
        res.status(500).json({ message: '서버 오류로 사용자 삭제에 실패했습니다.' });
    }
});

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});


