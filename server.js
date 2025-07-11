// server.js
require('dotenv').config(); // .env 파일 로드

const express = require('express');
const session = require('express-session');
const qs = require('qs');
const axios = require('axios');
const jwt = require('jsonwebtoken'); // JWT 사용을 위해 필요
const cors = require('cors'); // 프론트엔드와 백엔드 포트가 다를 때 CORS 문제 해결을 위해 필요

const db = require('./db'); // db.js 모듈 임포트

const app = express();

// --- 환경 변수 로드 (상단에 모아두는 것이 관리 용이) ---
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;
const KAKAO_REDIRECT_URI = process.env.KAKAO_REDIRECT_URI; // .env 파일에서 설정한 전체 URI
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 4000; // .env의 PORT를 사용하거나, 없으면 4000을 기본값으로

// 카카오 API 고정 주소 (변수로 정의)
const KAKAO_TOKEN_URI = "https://kauth.kakao.com/oauth/token";
const KAKAO_API_HOST = "https://kapi.kakao.com";

// --- Express 미들웨어 설정 ---
app.use(express.json()); // JSON 형식의 요청 본문을 파싱
app.use(express.urlencoded({ extended: true })); // URL-encoded 형식의 요청 본문을 파싱

// CORS 설정: React 프론트엔드 (http://localhost:3000)에서 요청을 허용
// 운영 환경에서는 '*' 대신 특정 프론트엔드 도메인을 명시해야 합니다.
app.use(cors({
    origin: 'http://localhost:3000', // React 프론트엔드가 실행되는 주소
    credentials: true // 세션 쿠키나 인증 헤더를 주고받을 경우 필요
}));

// 세션 설정 (JWT를 사용하더라도 OAuth 플로우 중 임시 데이터 저장에 유용)
app.use(
  session({
    secret: JWT_SECRET || "a very secret key for session", // .env에서 JWT_SECRET을 재활용하거나 별도 시크릿
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS 환경에서만 true
      httpOnly: true, // 클라이언트 스크립트에서 쿠키 접근 방지
      maxAge: 24 * 60 * 60 * 1000 // 24시간 유효 (밀리초)
    },
  })
);

// 정적 파일 서빙 설정 (만약 백엔드 서버에서 HTML/CSS/JS 파일을 직접 제공한다면)
// app.use(express.static(__dirname + '/public')); // 예를 들어, public 폴더에 정적 파일이 있다면

// --- API 엔드포인트 예시 (CRUD) ---
// 이제 email 컬럼이 없다고 가정하고 CRUD API들을 수정합니다.

// 1. 사용자 생성 (CREATE)
app.post('/users', async (req, res) => {
    // email 필드를 제거하고 name만 받음
    const { name } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO users (name) VALUES ($1) RETURNING *', // email 필드 제거
            [name]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        // email 관련 오류 메시지 제거
        console.error('사용자 생성 중 오류 발생:', err.stack);
        res.status(500).json({ message: '서버 오류로 사용자 생성에 실패했습니다.' });
    }
});

// 2. 모든 사용자 조회 (READ All)
app.get('/users', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM users ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('사용자 조회 중 오류 발생:', err.stack);
        res.status(500).json({ message: '서버 오류로 사용자 조회에 실패했습니다.' });
    }
});

// 3. 특정 사용자 ID로 조회 (READ One)
app.get('/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: '해당 ID의 사용자를 찾을 수 없습니다.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('특정 사용자 조회 중 오류 발생:', err.stack);
        res.status(500).json({ message: '서버 오류로 사용자 조회에 실패했습니다.' });
    }
});

// 4. 사용자 정보 업데이트 (UPDATE)
app.put('/users/:id', async (req, res) => {
    const { id } = req.params;
    // email 필드를 제거하고 name만 받음
    const { name } = req.body;
    try {
        const result = await db.query(
            'UPDATE users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', // email 필드 제거
            [name, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: '업데이트할 사용자를 찾을 수 없습니다.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        // email 관련 오류 메시지 제거
        console.error('사용자 업데이트 중 오류 발생:', err.stack);
        res.status(500).json({ message: '서버 오류로 사용자 업데이트에 실패했습니다.' });
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


// --- 카카오 로그인 관련 API 엔드포인트 ---

// 1. 카카오 로그인 시작 (프론트엔드에서 이 경로로 리다이렉트)
// 예: http://localhost:4000/auth/kakao/login
app.get("/auth/kakao/login", (req, res) => {
    let { scope } = req.query;
    let scopeParam = "";
    if (scope) {
        scopeParam = "&scope=" + scope;
    }

    const kakaoAuthUrl = `https://kauth.kakao.com/oauth/authorize?client_id=${KAKAO_REST_API_KEY}&redirect_uri=${KAKAO_REDIRECT_URI}&response_type=code${scopeParam}`;
    console.log('카카오 인증 URL:', kakaoAuthUrl);
    res.redirect(kakaoAuthUrl); // 카카오 인증 서버로 리다이렉트
});


// 2. 카카오 로그인 콜백 (카카오에서 인증 코드를 보내주는 경로)
// 카카오 개발자 센터에 등록된 리다이렉트 URI와 정확히 일치해야 합니다.
// 예: http://localhost:4000/auth/kakao/callback
app.get("/auth/kakao/callback", async (req, res) => { // 경로를 /auth/kakao/callback으로 수정
    const code = req.query.code; // 카카오로부터 받은 인증 코드

    if (!code) {
        console.error('카카오 콜백: 인가 코드가 없습니다.');
        return res.status(400).json({ message: '인가 코드가 없습니다.' });
    }

    try {
        // 1. 인증 코드로 Access Token 요청
        const tokenResponse = await axios.post(
            KAKAO_TOKEN_URI,
            qs.stringify({
                grant_type: "authorization_code",
                client_id: KAKAO_REST_API_KEY,
                redirect_uri: KAKAO_REDIRECT_URI,
                code: code,
                // client_secret: process.env.KAKAO_CLIENT_SECRET, // 클라이언트 시크릿 사용 시 추가
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
                },
            }
        );

        const { access_token, refresh_token } = tokenResponse.data;
        console.log('카카오 토큰 응답:', tokenResponse.data);

        // 2. Access Token으로 사용자 정보 요청
        const userResponse = await axios.get(`${KAKAO_API_HOST}/v2/user/me`, {
            headers: {
                Authorization: `Bearer ${access_token}`,
                'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            },
        });

        const kakaoUser = userResponse.data;
        console.log('카카오 사용자 정보:', kakaoUser);

        const kakaoId = kakaoUser.id;
        // 이메일 필드를 사용하지 않으므로 제거
        // const email = kakaoUser.kakao_account.email || null; // 이메일이 없으면 null로 설정
        const nickname = kakaoUser.kakao_account.profile.nickname;


        // 3. 데이터베이스에 사용자 정보 저장 또는 업데이트 (kakao_id 기반으로 변경)
        let userInDb;
        try {
            // kakao_id로 기존 사용자 조회
            const existingUserResult = await db.query('SELECT * FROM users WHERE kakao_id = $1', [kakaoId]);

            if (existingUserResult.rows.length > 0) {
                // 이미 존재하는 사용자라면 정보 업데이트 (닉네임만 업데이트)
                userInDb = existingUserResult.rows[0];
                await db.query(
                    'UPDATE users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE kakao_id = $2 RETURNING *', // email 필드 제거
                    [nickname, kakaoId]
                );
                console.log(`기존 사용자 (kakao_id: ${kakaoId}) 정보 업데이트`);
            } else {
                // 새로운 사용자라면 DB에 저장
                const newUserResult = await db.query(
                    'INSERT INTO users (kakao_id, name) VALUES ($1, $2) RETURNING *', // email 필드 제거
                    [kakaoId, nickname]
                );
                userInDb = newUserResult.rows[0];
                console.log(`새로운 사용자 (kakao_id: ${kakaoId}) DB에 저장`);
            }

            // 4. JWT 토큰 생성 및 클라이언트에 반환
            const tokenPayload = {
                id: userInDb.id,
                kakaoId: userInDb.kakao_id,
                name: userInDb.name // 닉네임 포함
            };
            // 이메일이 없으므로 토큰 페이로드에 포함하지 않음
            // if (userInDb.email) {
            //     tokenPayload.email = userInDb.email;
            // }

            const jwtToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1h' });

            // 세션에 카카오 Access Token 저장 (로그아웃/연결끊기 시 필요할 수 있음)
            req.session.kakaoAccessToken = access_token;

            // 성공적으로 로그인 처리 후 프론트엔드로 JSON 응답
            res.status(200).json({
                message: '카카오 로그인 성공 및 사용자 정보 처리 완료',
                user: {
                    id: userInDb.id,
                    kakao_id: userInDb.kakao_id,
                    name: userInDb.name,
                    // email: userInDb.email // 이메일이 없으므로 제거
                },
                token: jwtToken,
                kakao_access_token: access_token // 디버깅용으로 카카오 토큰도 함께 보냄
            });

        } catch (dbErr) {
            console.error('데이터베이스 처리 중 오류 발생:', dbErr.stack);
            res.status(500).json({ message: '데이터베이스 처리 중 오류가 발생했습니다.' });
        }

    } catch (error) {
        console.error('카카오 로그인 처리 중 오류 발생:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: '카카오 로그인 처리 중 오류가 발생했습니다.' });
    }
});


// 로그아웃 요청: 세션을 종료하고 사용자 로그아웃 처리
app.get("/auth/kakao/logout", async (req, res) => {
    const accessToken = req.session.kakaoAccessToken;
    if (!accessToken) {
        return res.status(400).json({ message: "로그인된 카카오 토큰이 없습니다." });
    }

    try {
        const logoutResponse = await axios.post(
            `${KAKAO_API_HOST}/v1/user/logout`,
            null,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        console.log('카카오 로그아웃 응답:', logoutResponse.data);

        req.session.destroy(err => {
            if (err) {
                console.error('세션 파괴 오류:', err);
                return res.status(500).json({ message: '로그아웃 중 오류가 발생했습니다.' });
            }
            res.status(200).json({ message: "카카오 로그아웃 성공!" });
        });
    } catch (error) {
        console.error('카카오 로그아웃 중 오류 발생:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: '카카오 로그아웃 중 오류가 발생했습니다.' });
    }
});

// 연결 끊기 요청: 사용자와 앱의 연결을 해제하고 세션 종료
app.get("/auth/kakao/unlink", async (req, res) => {
    const accessToken = req.session.kakaoAccessToken;
    if (!accessToken) {
        return res.status(400).json({ message: "로그인된 카카오 토큰이 없습니다." });
    }

    try {
        const unlinkResponse = await axios.post(
            `${KAKAO_API_HOST}/v1/user/unlink`,
            null,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        console.log('카카오 연결 끊기 응답:', unlinkResponse.data);

        req.session.destroy(err => {
            if (err) {
                console.error('세션 파괴 오류:', err);
                return res.status(500).json({ message: '연결 끊기 중 오류가 발생했습니다.' });
            }
            res.status(200).json({ message: "카카오 연결 끊기 성공!" });
        });
    } catch (error) {
        console.error('카카오 연결 끊기 중 오류 발생:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: '카카오 연결 끊기 중 오류가 발생했습니다.' });
    }
});


// --- 서버 시작 ---
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  console.log(`Kakao Redirect URI set to: ${KAKAO_REDIRECT_URI}`); // 디버깅용
});