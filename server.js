// server.js

// 1. 필요한 모듈 임포트
const express = require('express');             // 웹 서버 프레임워크
const dotenv = require('dotenv');               // 환경 변수 로드
const { Pool } = require('pg');                 // PostgreSQL 클라이언트
const axios = require('axios');                 // HTTP 요청
const qs = require('qs');                       // 쿼리스트링 변환
const jwt = require('jsonwebtoken');            // JWT 생성/검증
const session = require('express-session');     // 세션 관리
const cors = require('cors');                   // CORS 설정
const FormData = require('form-data');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const similarity = require('compute-cosine-similarity');
// 2. 환경 변수 로드 (.env 파일에서)
dotenv.config();

// 3. Express 애플리케이션 초기화
const app = express(); 
const port = process.env.PORT || 3000;

// 4. 미들웨어 설정
app.use(express.json());                       // JSON 바디 파싱
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true }
}));

// 5. PostgreSQL 데이터베이스 연결 설정
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// JWT 토큰 생성 함수
function generateJwtToken(userId, googleId, nickname) {
  const payload = { id: userId, googleId, nickname };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });
}

// 사용자 조회 또는 생성 함수
async function findOrCreateUser(googleId, nickname, email, picture) {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    if (res.rows.length) {
      await client.query(
        'UPDATE users SET nickname=$1, email=$2, profile_image_url=$3, updated_at=NOW() isonline=true WHERE google_id=$4',
        [nickname, email, picture, googleId]
      );
      return res.rows[0];
    } else {
      const ins = await client.query(
        'INSERT INTO users (google_id, nickname, email, profile_image_url, is_online) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [googleId, nickname, email, picture, true]
      );
      return ins.rows[0];
    }
  } finally {
    client.release();
  }
}

// 인증 미들웨어
function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ message: '토큰이 없습니다.' });
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(403).json({ message: '유효하지 않은 토큰입니다.' });
    req.user = { id: payload.id, nickname: payload.nickname };
    next();
  });
}

// --- Google OAuth 로그인 처리 ---
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

app.post('/auth/google/login', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: '인가 코드가 필요합니다.' });
  try {
    // 1) 구글 토큰 교환
    const tokenRes = await axios.post(
      GOOGLE_TOKEN_URI,
      qs.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { id_token } = tokenRes.data;

    // 2) ID 토큰 디코딩
    const decoded = jwt.decode(id_token);
    const googleId = decoded.sub;
    const nickname = decoded.name;
    const email = decoded.email;
    const picture = decoded.picture;

    // 3) 사용자 저장 또는 업데이트
    const user = await findOrCreateUser(googleId, nickname, email, picture);

    // 4) JWT 발급
    const appToken = generateJwtToken(user.user_id, googleId, nickname);
    res.json({ token: appToken, user });
  } catch (err) {
    console.error('구글 로그인 오류:', err.response?.data || err.message);
    res.status(500).json({ message: '구글 로그인 처리 중 오류가 발생했습니다.' });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // 예: uploads 폴더에 저장
  },
  filename: (req, file, cb) => {
    // 고유 파일명 생성 (예: 타임스탬프+원본확장자)
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  },
});
const upload = multer({ storage });
//----------------------------------------------------------------------------------
app.post('/uploaduser', upload.single('file'), async (myreq, myres) => {
  let client;
  try {
    client = await pool.connect();

    const meta = JSON.parse(myreq.body.meta);
    const form = new FormData();
    form.append('file', fs.createReadStream(myreq.file.path));

    const res = await axios.post('http://172.20.12.58:80/embedding', form, {
      headers: form.getHeaders(),
    });

    await client.query(
      'INSERT INTO user_photos (image_url, embedding_vector, uploaded_at) VALUES ($1,$2,$3,NOW()) RETURNING *',
      [meta.userid, myreq.file.path, res.data.embedding]
    );

    myres.json({ filePath: myreq.file.path, embedding: res.data.embedding });
  } catch (err) {
    myres.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

  app.post('/getsimilaranimal',(myreq,myres) => {
    const form = new FormData();
    const meta = JSON.parse(myreq.body.meta);
    form.append('file', fs.createReadStream(meta.imgurl));

    axios
      .post('http://172.20.12.58:80/predict', form, {
        headers: form.getHeaders(),
      })
      .then((res) => {
        console.log(res.data);
        myres.json({ animal: res.data.class, confidence: res.data.confidence });
      })
      .catch((err) => {
        console.error(err);
      });

  });

  app.post('/find_most_similar', async (req, res) => {
    const { embedding_vector } = req.body; // 512차원 배열
  
    if (!embedding_vector || !Array.isArray(embedding_vector)) {
      return res.status(400).json({ error: 'embedding_vector is required and must be an array' });
    }
  
    try {
      const client = await pool.connect();
  
      // pgvector: <=>는 cosine distance, 1 - distance가 similarity
      const query = `
        SELECT *, 1 - (embedding_vector <=> $1) AS similarity
        FROM target_photos
        ORDER BY embedding_vector <=> $1
        LIMIT 1
      `;
      const { rows } = await client.query(query, [embedding_vector]);
      client.release();
  
      if (rows.length === 0) {
        return res.status(404).json({ error: 'No target photos found' });
      }
  
      // 가장 닮은 객체 + similarity 반환
      return res.json(rows[0]);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });


  app.post('/getsimilarity', (req,res) => {
    const client = pool.connect();
    const meta = JSON.parse(req.body.meta);
    const vecA = meta.vec1; // 512차원 배열
    const vecB = meta.vec2; // 512차원 배열
    const score = similarity(vecA, vecB);
    const percent = ((score + 1) / 2) * 100
    console.log(percent); // -1 ~ 1 사이의 값
    client.query('INSERT INTO similarity_results (user_photo_id, target_type, target_photo_id, uploaded_photo_id, similarity_score, analyzed_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *',
        [meta.user_photo_id, meta.target_photo_id, meta.uploaded_photo_id, percent]);
    res.json({score:percent});
    }
  );
  // 예시 보호된 라우트
  app.get('/api/profile', authenticateToken, (req, res) => {
    res.json({ message: '프로필 정보 접근 허용', user: req.user });
});

// 기존 라우트
app.get('/', (req, res) => res.send('Welcome to the Facer Backend!'));
app.get('/api/test', (req, res) => res.json({ message: 'Hello from backend!', status: 'ok' }));
app.get('/api/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const { rows } = await client.query('SELECT NOW() AS now');
    client.release();
    res.json({ time: rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 서버 시작
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server listening on port ${port}`);
});
