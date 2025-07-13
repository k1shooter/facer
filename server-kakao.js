// server.js

// 1. 필요한 모듈 임포트
const express = require('express');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const axios = require('axios');
const qs = require('qs');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const cors = require('cors');

// 2. 환경 변수 로드 (.env 파일에서)
dotenv.config();

// 3. Express 애플리케이션 초기화
const app = express();
const port = process.env.PORT || 80;

// 4. 미들웨어 설정
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS 설정 (undefined origin 필터링)
app.use(cors({
    origin: [
        process.env.FRONTEND_URL,
        'http://localhost:5173',
        'http://127.0.0.1:5173'
    ].filter(u => !!u),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(session({
    secret: process.env.JWT_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// 5. PostgreSQL 데이터베이스 연결 설정
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
});

// 카카오 API 및 JWT 설정
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET;
const KAKAO_AUTH_REDIRECT_URI = process.env.KAKAO_AUTH_REDIRECT_URI;
const KAKAO_TOKEN_URI = "https://kauth.kakao.com/oauth/token";
const KAKAO_API_HOST = "https://kapi.kakao.com";
const JWT_SECRET = process.env.JWT_SECRET;

// JWT 토큰 생성 함수
function generateJwtToken(userId, kakaoId, nickname) {
    if (!JWT_SECRET) {
        console.error("JWT_SECRET 환경 변수가 설정되지 않았습니다.");
        throw new Error("Server configuration error: JWT_SECRET not defined.");
    }
    const payload = { id: userId, kakaoId, nickname };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

// 사용자 정보를 DB에서 찾거나 새로 생성
async function findOrCreateUser(kakaoId, nickname, profileImageUrl) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            'SELECT * FROM users WHERE kakao_id = $1',
            [kakaoId]
        );
        let user;
        if (rows.length) {
            user = rows[0];
            await client.query(
                'UPDATE users SET nickname=$1, profile_image_url=$2, updated_at=CURRENT_TIMESTAMP WHERE kakao_id=$3',
                [nickname, profileImageUrl, kakaoId]
            );
        } else {
            const result = await client.query(
                'INSERT INTO users (kakao_id, nickname, profile_image_url, is_online) VALUES ($1,$2,$3,$4) RETURNING *',
                [kakaoId, nickname, profileImageUrl, true]
            );
            user = result.rows[0];
        }
        return user;
    } finally {
        client.release();
    }
}

// DB 연결 테스트
async function testDbConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Database connected successfully!');
        const res = await client.query("SELECT 1 FROM pg_extension WHERE extname='vector';");
        console.log(res.rows.length
            ? '✅ pgvector extension is active.'
            : '⚠️ pgvector extension is NOT active. Run CREATE EXTENSION IF NOT EXISTS vector;'
        );
        client.release();
    } catch (err) {
        console.error('❌ Database connection error:', err.stack);
    }
}

// --- 라우트 정의 ---
app.get('/', (req, res) => {
    res.send('Welcome to the Facer Node.js Backend!');
});

app.get('/api/test', (req, res) => {
    res.json({ message: 'Hello from Node.js Backend!', status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/db-test', async (req, res) => {
    try {
        const client = await pool.connect();
        const { rows } = await client.query('SELECT NOW() AS current_time');
        client.release();
        res.json({ message: 'Database connection successful!', currentTime: rows[0].current_time });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to connect to database.', error: error.message });
    }
});

// --- 카카오 로그인 처리 ---
app.post("/auth/kakao/login", async (req, res) => {
    const code = req.body.code;
    if (!code) return res.status(400).json({ message: '인가 코드가 없습니다.' });

    try {
        const tokenRes = await axios.post(
            KAKAO_TOKEN_URI,
            qs.stringify({
                grant_type: "authorization_code",
                client_id: KAKAO_REST_API_KEY,
                client_secret: KAKAO_CLIENT_SECRET,
                redirect_uri: KAKAO_AUTH_REDIRECT_URI,
                code
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, timeout: 30000 }
        );
        const { access_token, refresh_token } = tokenRes.data;
        const userRes = await axios.get(`${KAKAO_API_HOST}/v2/user/me`, {
            headers: { Authorization: `Bearer ${access_token}` }
        });
        const kakaoUser = userRes.data;
        const user = await findOrCreateUser(
            kakaoUser.id,
            kakaoUser.kakao_account.profile?.nickname || `User_${kakaoUser.id}`,
            kakaoUser.kakao_account.profile?.profile_image_url || null
        );
        const jwtToken = generateJwtToken(user.user_id, user.kakao_id, user.nickname);
        req.session.kakaoAccessToken = access_token;
        req.session.kakaoRefreshToken = refresh_token;
        res.json({
            message: '카카오 로그인 성공',
            user: { user_id: user.user_id, kakao_id: user.kakao_id, nickname: user.nickname, profile_image_url: user.profile_image_url, is_online: user.is_online },
            token: jwtToken,
            kakao_access_token: access_token
        });
    } catch (err) {
        console.error('카카오 로그인 오류:', err.response?.data || err.message);
        res.status(500).json({ message: '카카오 로그인 처리 중 오류가 발생했습니다.' });
    }
});

// --- 카카오 로그아웃 ---
app.post("/auth/kakao/logout", async (req, res) => {
    let accessToken = req.body.kakaoAccessToken;
    if (!accessToken) {
        if (!req.session.kakaoAccessToken) {
            return res.status(400).json({ message: "로그인된 카카오 토큰이 없습니다." });
        }
        accessToken = req.session.kakaoAccessToken;
    }

    try {
        await axios.post(`${KAKAO_API_HOST}/v1/user/logout`, null, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        req.session.destroy(err => {
            if (err) {
                console.error('세션 파괴 오류:', err);
                return res.status(500).json({ message: '로그아웃 중 오류가 발생했습니다.' });
            }
            res.json({ message: "카카오 로그아웃 성공!" });
        });
    } catch (err) {
        console.error('카카오 로그아웃 오류:', err.response?.data || err.message);
        res.status(500).json({ message: '카카오 로그아웃 중 오류가 발생했습니다.' });
    }
});

// --- 카카오 연결 끊기 (회원 탈퇴) ---
app.post("/auth/kakao/unlink", async (req, res) => {
    let accessToken = req.body.kakaoAccessToken;
    if (!accessToken) {
        if (!req.session.kakaoAccessToken) {
            return res.status(400).json({ message: "로그인된 카카오 토큰이 없습니다." });
        }
        accessToken = req.session.kakaoAccessToken;
    }

    try {
        await axios.post(`${KAKAO_API_HOST}/v1/user/unlink`, null, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        // (선택) DB에서 사용자 삭제 로직 추가 가능
        req.session.destroy(err => {
            if (err) {
                console.error('세션 파괴 오류:', err);
                return res.status(500).json({ message: '연결 끊기 중 오류가 발생했습니다.' });
            }
            res.json({ message: "카카오 연결 끊기 성공!" });
        });
    } catch (err) {
        console.error('카카오 연결 끊기 오류:', err.response?.data || err.message);
        res.status(500).json({ message: '카카오 연결 끊기 중 오류가 발생했습니다.' });
    }
});

// --- 서버 시작 ---
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${port}`);
    console.log(`Frontend Callback URI: ${KAKAO_AUTH_REDIRECT_URI}`);
    console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
    testDbConnection();
});
