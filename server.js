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
const sharp = require('sharp');
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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

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
        'UPDATE users SET nickname=$1, email=$2, profile_image_url=$3, updated_at=NOW() WHERE google_id=$4',
        [nickname, email, picture, googleId]
      );
      return res.rows[0];
    } else {
      const ins = await client.query(
        'INSERT INTO users (google_id, nickname, email, profile_image_url) VALUES ($1,$2,$3,$4) RETURNING *',
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
    if (err) {
      if (err.name === 'TokenExpiredError') {
        // 만료된 토큰
        return res.status(401).json({ message: '토큰이 만료되었습니다.' });
      }
      return res.status(403).json({ 
        message: '유효하지 않은 토큰입니다.', 
        error: err.message,       // 예: jwt malformed
        name:  err.name,          // JsonWebTokenError 등
        stack: err.stack,
      });
    }
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

app.post('/auth/email/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'email과 password가 모두 필요합니다.' });
  }

  let client;
  try {
    client = await pool.connect();

    // 1) 사용자 조회
    const userRes = await client.query(
      `SELECT user_id, email, nickname, password, profile_image_url
       FROM users
       WHERE email = $1`,
      [email]
    );
    if (userRes.rows.length === 0) {
      return res.status(401).json({ message: '이메일 또는 비밀번호가 일치하지 않습니다.' });
    }
    const user = userRes.rows[0];

    // 2) 비밀번호 검증 (평문 비교 또는 bcrypt.compare)
    // const isMatch = await bcrypt.compare(password, user.password);
    const isMatch = password == user.password;
    if (!isMatch) {
      return res.status(401).json({ message: '이메일 또는 비밀번호가 일치하지 않습니다.' });
    }

    // 3) 앱 JWT 발급
    const appToken = generateJwtToken(user.user_id, user.email, user.nickname);

    // 4) 온라인 상태 업데이트 (선택)
    await client.query(
      `UPDATE users
         SET is_online = true
       WHERE user_id = $1`,
      [user.user_id]
    );

    // 5) 응답
    res.json({
      token: appToken,
      user: {
        user_id: user.user_id,
        email: user.email,
        nickname: user.nickname,
        profile_image_url: user.profile_image_url,
        is_online: true,
      },
    });
  } catch (err) {
    console.error('EMAIL LOGIN ERROR:', err);
    res.status(500).json({ message: '로그인 중 오류가 발생했습니다.' });
  } finally {
    client?.release();
  }
});

//닉네임, 이메일, 비밀번호를 받아서 가입, 디비에 들어감
app.post('/auth/register', async (req, res) => {
  const { email, nickname, password } = req.body;
  if (!email || !nickname || !password) {
    return res.status(400).json({ message: 'email, nickname, password 모두 필요합니다.' });
  }

  let client;
  try {
    client = await pool.connect();

    // 이미 같은 이메일이 있는지 체크
    const dup = await client.query(
      'SELECT 1 FROM users WHERE email = $1',
      [email]
    );
    if (dup.rows.length) {
      return res.status(409).json({ message: '이미 사용 중인 이메일입니다.' });
    }

    // 사용자 생성 (password는 평문 저장)
    const ins = await client.query(
      `INSERT INTO users
         (email, nickname, password, is_online)
       VALUES ($1, $2, $3, true)
       RETURNING user_id, email, nickname, profile_image_url, created_at`,
      [email, nickname, password]
    );
    const user = ins.rows[0];
    res.json({ message: '회원가입 완료', user });
  } catch (err) {
    console.error('REGISTER ERROR:', err);
    res.status(500).json({ message: '회원가입 중 오류가 발생했습니다.' });
  } finally {
    if (client) client.release();
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
app.post('/uploaduser', authenticateToken, upload.single('file'),  async (myreq, myres) => {
  let client;
  try {
    client = await pool.connect();

    // let meta;
    // if (myreq.body.meta) {
    //     try {
    //         meta = JSON.parse(myreq.body.meta);
    //     } catch (e) {
    //         console.error("meta JSON 파싱 실패:", e);
    //         return myres.status(400).json({ error: "잘못된 meta JSON 형식입니다." });
    //     }
    // } else {
    //     // meta 데이터가 없는 경우 (예: curl 명령에서 meta 필드를 빼먹었을 때)
    //     return myres.status(400).json({ error: "meta 데이터가 누락되었습니다." });
    // }
    const userId = myreq.user.id;

    const form = new FormData();
    form.append('file', fs.createReadStream(myreq.file.path));

    const res = await axios.post('http://172.20.12.58:80/embedding', form, {
      headers: form.getHeaders(),
    });

    const { embedding: embeddingVectorRaw, facial_area: facialArea, facial_confidence: facialConfidence } = res.data;
    let embeddingVectorString; // 변환된 벡터 문자열을 저장할 변수
    if (Array.isArray(embeddingVectorRaw) && embeddingVectorRaw.length === 512) {
        // JavaScript 배열을 pgvector가 기대하는 문자열 '[val1, val2, ...]' 형태로 변환
        embeddingVectorString = `[${embeddingVectorRaw.join(',')}]`; 
        console.log('pgvector 형식으로 변환된 임베딩:', embeddingVectorString.substring(0, 50), '...'); // 일부만 로깅
    } else {
        throw new Error(`Flask로부터 받은 임베딩 벡터의 차원이 ${embeddingVectorRaw ? embeddingVectorRaw.length : '없음'}로 예상치 못한 값입니다. (기대: 1536)`);
    }

    const insertResult = await client.query(
        // 👈 INSERT 쿼리 수정: user_id, image_url, embedding_vector, facial_area, facial_confidence를 모두 삽입
        // uploaded_at은 DEFAULT CURRENT_TIMESTAMP이므로 쿼리에서 명시하지 않아도 됩니다.
        'INSERT INTO user_photos (user_id, image_url, embedding_vector, uploaded_at) VALUES ($1, $2, $3, NOW()) RETURNING user_photo_id, image_url, uploaded_at',
        [userId, myreq.file.path, embeddingVectorString] // 👈 변환된 embeddingVectorString과 얼굴 정보 사용
    );
    const newPhoto = insertResult.rows[0];
    const userPhotoId = newPhoto.user_photo_id;

    // console.log(`사진 정보 DB에 초기 저장됨. ID: ${userPhotoId}, URL: ${fileUrl}`);
    // console.log(`사진 ID ${userPhotoId}의 임베딩 및 얼굴 정보 DB에 업데이트 완료.`); // 이제 업데이트가 아닌 삽입 시점에 모두 저장

    myres.json({
        message: '사진이 성공적으로 업로드 및 처리되었습니다.',
        photo: {
            user_photo_id: newPhoto.user_photo_id,
            image_url: newPhoto.image_url,
            uploaded_at: newPhoto.uploaded_at,
            facial_area: facialArea,
            facial_confidence: facialConfidence,
            embedding: embeddingVectorString
        }
    });
  } catch (err) {
    myres.status(500).json({ error: err.message });
    console.log(err.message);
  } finally {
    if (client) client.release();
  }
});

app.post('/uploadtarget', upload.single('file'), async (myreq, myres) => {
  let client;
  try {
    client = await pool.connect();

    let meta;
    if (myreq.body.meta) {
        try {
            meta = JSON.parse(myreq.body.meta);
        } catch (e) {
            console.error("meta JSON 파싱 실패:", e);
            return myres.status(400).json({ error: "잘못된 meta JSON 형식입니다." });
        }
    } else {
        // meta 데이터가 없는 경우 (예: curl 명령에서 meta 필드를 빼먹었을 때)
        return myres.status(400).json({ error: "meta 데이터가 누락되었습니다." });
    }
    const form = new FormData();
    form.append('file', fs.createReadStream(myreq.file.path));

    const res = await axios.post('http://172.20.12.58:80/embedding', form, {
      headers: form.getHeaders(),
    });

    const { embedding: embeddingVectorRaw, facial_area: facialArea, facial_confidence: facialConfidence } = res.data;
    let embeddingVectorString; // 변환된 벡터 문자열을 저장할 변수
    if (Array.isArray(embeddingVectorRaw) && embeddingVectorRaw.length === 512) {
        // JavaScript 배열을 pgvector가 기대하는 문자열 '[val1, val2, ...]' 형태로 변환
        embeddingVectorString = `[${embeddingVectorRaw.join(',')}]`; 
        console.log('pgvector 형식으로 변환된 임베딩:', embeddingVectorString.substring(0, 50), '...'); // 일부만 로깅
    } else {
        throw new Error(`Flask로부터 받은 임베딩 벡터의 차원이 ${embeddingVectorRaw ? embeddingVectorRaw.length : '없음'}로 예상치 못한 값입니다. (기대: 1536)`);
    }

    const insertResult = await client.query(
        // 👈 INSERT 쿼리 수정: user_id, image_url, embedding_vector, facial_area, facial_confidence를 모두 삽입
        // uploaded_at은 DEFAULT CURRENT_TIMESTAMP이므로 쿼리에서 명시하지 않아도 됩니다.
        'INSERT INTO target_photos (type, name, image_url, embedding_vector, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [meta.type, meta.name, myreq.file.path, embeddingVectorString] // 👈 변환된 embeddingVectorString과 얼굴 정보 사용
    );
    const newPhoto = insertResult.rows[0];
    const userPhotoId = newPhoto.user_photo_id;

    // console.log(`사진 정보 DB에 초기 저장됨. ID: ${userPhotoId}, URL: ${fileUrl}`);
    // console.log(`사진 ID ${userPhotoId}의 임베딩 및 얼굴 정보 DB에 업데이트 완료.`); // 이제 업데이트가 아닌 삽입 시점에 모두 저장

    myres.json({
        message: '사진이 성공적으로 업로드 및 처리되었습니다.',
        photo: {
            target_photo_id: newPhoto.user_photo_id,
            type: newPhoto.type,
            name: newPhoto.name,
            image_url: newPhoto.image_url,
            created_at: newPhoto.created_at,
            facial_area: facialArea,
            facial_confidence: facialConfidence,
            embedding: embeddingVectorString
        }
    });
  } catch (err) {
    myres.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

app.post('/uploadtarget', upload.single('file'), async (myreq, myres) => {
  let client;
  try {
    client = await pool.connect();

    let meta;
    if (myreq.body.meta) {
        try {
            meta = JSON.parse(myreq.body.meta);
        } catch (e) {
            console.error("meta JSON 파싱 실패:", e);
            return myres.status(400).json({ error: "잘못된 meta JSON 형식입니다." });
        }
    } else {
        // meta 데이터가 없는 경우 (예: curl 명령에서 meta 필드를 빼먹었을 때)
        return myres.status(400).json({ error: "meta 데이터가 누락되었습니다." });
    }
    const form = new FormData();
    form.append('file', fs.createReadStream(myreq.file.path));

    const res = await axios.post('http://172.20.12.58:80/embedding', form, {
      headers: form.getHeaders(),
    });

    const { embedding: embeddingVectorRaw, facial_area: facialArea, facial_confidence: facialConfidence } = res.data;
    let embeddingVectorString; // 변환된 벡터 문자열을 저장할 변수
    if (Array.isArray(embeddingVectorRaw) && embeddingVectorRaw.length === 512) {
        // JavaScript 배열을 pgvector가 기대하는 문자열 '[val1, val2, ...]' 형태로 변환
        embeddingVectorString = `[${embeddingVectorRaw.join(',')}]`; 
        console.log('pgvector 형식으로 변환된 임베딩:', embeddingVectorString.substring(0, 50), '...'); // 일부만 로깅
    } else {
        throw new Error(`Flask로부터 받은 임베딩 벡터의 차원이 ${embeddingVectorRaw ? embeddingVectorRaw.length : '없음'}로 예상치 못한 값입니다. (기대: 1536)`);
    }

    const insertResult = await client.query(
        // 👈 INSERT 쿼리 수정: user_id, image_url, embedding_vector, facial_area, facial_confidence를 모두 삽입
        // uploaded_at은 DEFAULT CURRENT_TIMESTAMP이므로 쿼리에서 명시하지 않아도 됩니다.
        'INSERT INTO target_photos (type, name, image_url, embedding_vector, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [meta.type, meta.name, myreq.file.path, embeddingVectorString] // 👈 변환된 embeddingVectorString과 얼굴 정보 사용
    );
    const newPhoto = insertResult.rows[0];
    const userPhotoId = newPhoto.user_photo_id;

    // console.log(`사진 정보 DB에 초기 저장됨. ID: ${userPhotoId}, URL: ${fileUrl}`);
    // console.log(`사진 ID ${userPhotoId}의 임베딩 및 얼굴 정보 DB에 업데이트 완료.`); // 이제 업데이트가 아닌 삽입 시점에 모두 저장

    myres.json({
        message: '사진이 성공적으로 업로드 및 처리되었습니다.',
        photo: {
            target_photo_id: newPhoto.user_photo_id,
            type: newPhoto.type,
            name: newPhoto.name,
            image_url: newPhoto.image_url,
            created_at: newPhoto.created_at,
            facial_area: facialArea,
            facial_confidence: facialConfidence,
            embedding: embeddingVectorString
        }
    });
  } catch (err) {
    myres.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});  


app.post(
  '/getsimilaranimal',
  async (req, res) => {
    console.log('Received request for /getsimilaranimal');
    try {
      // 1) 클라이언트 요청 본문에서 'image_url'을 추출합니다.
      const { image_url, x, y, w, h } = req.body;

      // 'image_url'이 제공되었는지 확인합니다.
      if (!image_url) {
        return res.status(400).json({ error: 'image_url이 제공되지 않았습니다.' });
      }

      console.log('Image URL:', image_url);

      let localPath = image_url;
      try {
        const urlObj = new URL(image_url);
        // URL pathname 예: '/uploads/1752481925180.jpg'
        localPath = `.${urlObj.pathname}`; // 서버 프로젝트 루트 기준 상대 경로
      } catch (e) {
        // image_url이 URL 형식이 아닐 경우 그대로 사용
      }

      // 1. 이미지 crop
      const croppedPath = `uploads/cropped_${Date.now()}.jpg`;
      await sharp(localPath)
        .extract({ left: Math.round(x), top: Math.round(y), width: Math.round(w), height: Math.round(h) })
        .toFile(croppedPath);

      // 2. FormData 생성 및 API 요청
      const form = new FormData();
      form.append('file', fs.createReadStream(croppedPath));

      // 4) 외부 예측 API ('http://172.20.12.58:80/predict')를 호출합니다.
      // 'form.getHeaders()'는 FormData에 필요한 'Content-Type' 헤더를 자동으로 설정합니다.
      const response = await axios.post(
        'http://172.20.12.58:80/predict', 
        form, 
        {
          headers: form.getHeaders(),
        });

      // 3. 임시 파일 삭제
      fs.unlink(croppedPath, (err) => {
        if (err) console.error('임시 파일 삭제 실패:', err);
      });

      // 5) 외부 API 응답에서 'class'와 'confidence'를 추출합니다.
      // 'class'는 'animal' 변수로 이름을 변경합니다.
      const { class: animal, confidence } = response.data;

      // 6) 클라이언트에 예측 결과를 응답합니다.
      res.json({ animal, confidence });
    } catch (err) {
      // 에러 발생 시 콘솔에 로깅하고 클라이언트에 에러 응답을 보냅니다.
      console.error('getsimilaranimal error:', err.message);
      // Axios 에러인 경우 (예: 외부 API 연결 실패) 더 자세한 정보를 로깅합니다.
      if (axios.isAxiosError(err)) {
        console.error('Axios error details:', err.response?.data || err.message);
      }
      res.status(500).json({ error: '닮은 동물 예측에 실패했습니다.', details: err.message });
    }
  }
);
  app.post('/find_most_similar', async (req, res) => {
    const { embedding_vector } = req.body; // 512차원 배열
  
    if (!embedding_vector || !Array.isArray(embedding_vector)) {
      return res.status(400).json({ error: 'embedding_vector is required and must be an array' });
    }

    const vectorLiteral = `[${embedding_vector.join(',')}]`;
  
    try {
      const client = await pool.connect();
  
      // pgvector: <=>는 cosine distance, 1 - distance가 similarity
      const query = `
        SELECT *, 1 - (embedding_vector <=> $1) AS similarity
        FROM target_photos
        ORDER BY embedding_vector <=> $1
        LIMIT 1
      `;
      const { rows } = await client.query(query, [vectorLiteral]);
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
//-------------------------------------------------------------------------------------------------

app.get('/searchnickname', async (req, res) => {
  const { nickname } = req.query;
  if (!nickname) {
    return res.status(400).json({ error: 'nickname 파라미터가 필요합니다.' });
  }
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM users WHERE nickname = $1',
      [nickname]
    );
    res.json(result.rows); // 닉네임이 일치하는 모든 유저 정보 반환
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB 조회 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});


app.patch('/userupdate', async (req, res) => {
  const { userid, nickname, profile_image_url, is_online } = req.body;
  if (!userid) {
    return res.status(400).json({ error: 'userid가 필요합니다.' });
  }

  // 변경할 필드만 동적으로 쿼리 생성
  const fields = [];
  const values = [];
  let idx = 1;

  if (nickname !== undefined) {
    fields.push(`nickname = $${idx++}`);
    values.push(nickname);
  }
  if (profile_image_url !== undefined) {
    fields.push(`profile_image_url = $${idx++}`);
    values.push(profile_image_url);
  }
  if (is_online !== undefined) {
    fields.push(`is_online = $${idx++}`);
    values.push(is_online);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: '수정할 값이 없습니다.' });
  }

  values.push(userid);

  const sql = `UPDATE users SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`;

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(sql, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '해당 유저를 찾을 수 없습니다.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB 업데이트 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});

//-----------------------------------------------------------------------------------------
// server.js

// GET /contests — 콘테스트 목록 + 참가자
app.get('/contests', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query(`
      SELECT
        c.contest_id,
        c.title,
        c.description,
        c.target_name,
        c.target_image_url,
        c.status,
        COALESCE(
          json_agg(
            json_build_object(
              'user_id', u.user_id,
              'nickname', u.nickname,
              'profile_image_url', u.profile_image_url
            )
          ) FILTER (WHERE u.user_id IS NOT NULL),
        '[]'
        ) AS participants
      FROM contests c
      LEFT JOIN contest_entries ce
        ON ce.contest_id = c.contest_id
      LEFT JOIN users u
        ON u.user_id = ce.user_id
      GROUP BY
        c.contest_id,
        c.title,
        c.description,
        c.target_name,
        c.target_image_url,
        c.status
      ORDER BY c.start_date DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /contests error:', err);
    res.status(500).json({ error: '콘테스트 목록 조회 중 오류 발생' });
  } finally {
    client?.release();
  }
});


app.post(
  '/contestsadd',
  authenticateToken,      // 로그인 필요 없으면 제거
  upload.single('file'),  // form-data의 file 필드
  async (req, res) => {
    const {
      target_name,
      title,
      description,
      status
    } = req.body;

    // 파일 체크
    if (!req.file) {
      return res.status(400).json({ error: '이미지 파일이 필요합니다.' });
    }
    if (!target_name || !title || !description || !status) {
      return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    // 1) 업로드된 파일 URL 생성
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

    // 2) 외부 임베딩 API 호출
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(req.file.path));
      const embedRes = await axios.post(
        'http://172.20.12.58:80/embedding',
        form,
        { headers: form.getHeaders() }
      );

      const { embedding: rawVec } = embedRes.data;
      if (!Array.isArray(rawVec) || rawVec.length !== 512) {
        throw new Error(`임베딩 길이가 ${rawVec?.length}로 올바르지 않습니다.`);
      }
      const vecString = `[${rawVec.join(',')}]`;  // pgvector 문자열

      // 3) DB에 INSERT (target_image_url + target_embedding 모두 저장)
      const client = await pool.connect();
      const sql = `
        INSERT INTO contests
          (target_name, target_image_url, title, description, status, start_date, target_embedding)
        VALUES
          ($1, $2, $3, $4, $5, NOW(), $6::vector)
        RETURNING *`;
      const vals = [
        target_name,
        imageUrl,
        title,
        description,
        status,
        vecString
      ];
      const result = await client.query(sql, vals);
      client.release();

      return res.json(result.rows[0]);
    } catch (err) {
      console.error('POST /contestsadd error:', err);
      return res.status(500).json({ error: err.message || 'DB 저장 중 오류 발생' });
    }
  }
);


app.post('/contest_entry_add', async (req, res) => {
  const {
    contest_id,
    user_id,
    user_photo_id,
  } = req.body;

  // 필수값 체크
  if (!contest_id || !user_id || !user_photo_id) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let similarity_score

  let client;
  try {
    client = await pool.connect();
    const getter = await client.query(
      `SELECT target_embedding FROM contests WHERE contest_id = $1`,[contest_id]
    );
    const getter2=await client.query(
      `SELECT embedding_vector FROM user_photos WHERE user_id = $1 AND user_photo_id = $2`,[user_id, user_photo_id]
    );

    const vec1 = JSON.parse(getter.rows[0].target_embedding); // 예: [0.1, 0.2, ...]
    const vec2 = JSON.parse(getter2.rows[0].embedding_vector);
    console.log(vec1);
    console.log(vec2);

    similarity_score = similarity(vec1, vec2);

    console.log("여기",similarity_score);
    



    const result = await client.query(
      `INSERT INTO contest_entries 
        (contest_id, user_id, user_photo_id, similarity_score, submitted_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [contest_id, user_id, user_photo_id, similarity_score]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ 
      error: 'DB 저장 중 오류 발생' ,
      detail: err.message
    });
  } finally {
    if (client) client.release();
  }
});

app.patch('/update_contest_top3', async (req, res) => {
  const { contest_id } = req.body;

  if (!contest_id) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let client;
  try {
    client = await pool.connect();
    const getter = await client.query(
      `SELECT * FROM contest_entries WHERE contest_id = $1 ORDER BY similarity_score DESC LIMIT 3`,
      [contest_id]
    );

    // 엔트리가 3개 미만일 경우 null로 채움
    const first = getter.rows[0] || {};
    const second = getter.rows[1] || {};
    const third = getter.rows[2] || {};

    const result = await client.query(
      `UPDATE contests 
       SET first_user_id=$1, second_user_id=$2, third_user_id=$3
       WHERE contest_id = $4 
       RETURNING *`,
      [
        first.user_id || null,
        second.user_id || null,
        third.user_id || null,
        contest_id
      ]
    );

    res.json({
      first_photo_id: first.user_photo_id || null,
      second_photo_id: second.user_photo_id || null,
      third_photo_id: third.user_photo_id || null,
      first_score: first.similarity_score || null,
      second_score: second.similarity_score || null,
      third_score: third.similarity_score || null
    });
  } catch (err) {
    res.status(500).json({ error: '123등 업데이트 실패 ㅎㅎ' });
  } finally {
    if (client) client.release();
  }
});

// PATCH /contests/status
app.patch('/contests/status', async (req, res) => {
  const { contest_id, status } = req.body;
  if (!contest_id || !status) {
    return res.status(400).json({ error: 'contest_id와 status가 필요합니다.' });
  }
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'UPDATE contests SET status = $1 WHERE contest_id = $2 RETURNING *',
      [status, contest_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '해당 콘테스트를 찾을 수 없습니다.' });
    }
    res.json({ message: 'status 수정 완료', contest: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'status 수정 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});

//---------------------------------------------------------------------------------
//notification 목록
app.get('/notifications', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  let client;

  try {
    client = await pool.connect();

    const { rows } = await client.query(
      `SELECT 
         notification_id,
         message,
         is_read,
         created_at,
         friendships_id
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    const notifications = rows.map(r => ({
      notification_id:             r.notification_id,
      message:        r.message,
      is_read:         r.is_read,
      created_at:      r.created_at,
      friendships_id:   r.friendships_id  // 프론트에서는 여기로 사용
    }));

    res.json(notifications);
  } catch (err) {
    console.error('GET /notifications error:', err);
    res.status(500).json({ error: '알림 목록 조회 중 오류가 발생했습니다.' });
  } finally {
    if (client) client.release();
  }
});


app.post('/notification_add', async (req, res) => {
  const {
    user_id,
    message,
    friendships_id   // 여기도 함께 받아옵니다
  } = req.body;

  // 필수값 체크
  if (!user_id || !message || !friendships_id) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `INSERT INTO notifications 
        (user_id, message, friendships_id, is_read, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [user_id, message, friendships_id, false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /notification_add error:', err);
    res.status(500).json({ error: 'DB 저장 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});

app.post('/notification_delete', async (req, res) => {
  const {
    user_id,
    notification_id,
    } = req.body;

  // 필수값 체크
  if (!user_id || !notification_id) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `DELETE FROM notifications 
       WHERE user_id=$1 AND notification_id=$2
       RETURNING *`,
      [user_id, notification_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB 저장 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});

// (1) 친구 요청 수락/거절용 PATCH 라우트 — 최상위에 선언
app.patch(
  '/friendship/:friendship_id',
  authenticateToken,
  async (req, res) => {
    const { friendship_id } = req.params;
    const { status } = req.body; // 'accepted' 또는 'rejected'

    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "status는 'accepted' 또는 'rejected'여야 합니다." });
    }

    let client;
    try {
      client = await pool.connect();
      const result = await client.query(
        `UPDATE friendships
           SET status = $1,
               responded_at = NOW()
         WHERE friendships_id = $2
         RETURNING *`,
        [status, friendship_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: '해당 friendship_id를 찾을 수 없습니다.' });
      }
      res.json(result.rows[0]);
    } catch (err) {
      console.error('PATCH /friendship/:friendship_id error:', err);
      res.status(500).json({ error: '친구 요청 업데이트 중 오류가 발생했습니다.' });
    } finally {
      client?.release();
    }
  }
);

// (2) 친구 요청 생성용 POST 라우트 — 별도 선언
app.post('/friendship_add', async (req, res) => {
  const {
    requester_user_id,
    receiver_user_id,
    status,
  } = req.body;

  if (!requester_user_id || !receiver_user_id || !status) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `INSERT INTO friendships 
         (requester_user_id, receiver_user_id, status, requested_at, responded_at)
       VALUES ($1, $2, $3, NOW(), NULL)
       RETURNING *`,
      [requester_user_id, receiver_user_id, status]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('=== DB ERROR START ===');
    console.error(err);               // err.message + err.code 등 기본 출력
    console.error(err.stack);         // 스택 트레이스
    console.error('detail:', err.detail);   // PG 에러 객체에만 있는 상세 메시지
    console.error('hint:', err.hint);       // (있으면) 힌트 정보
    console.error('constraint:', err.constraint); // 위반된 제약조건 이름
    console.error('=== DB ERROR END ===');
    console.error('POST /friendship_add error:', err);
    res.status(500).json({
      error: err.message,      // 일반 에러 메시지
      code: err.code,          // Postgres 에러 코드 (예: '23505' 등)
      detail: err.detail,      // 제약 위반 등 상세 설명
      hint: err.hint,          // (있으면) 힌트
      constraint: err.constraint, // (있으면) 제약조건 이름
    });
  } finally {
    client?.release();
  }
});


app.delete('/friendship_delete', async (req, res) => {
  const {
    requester_user_id,
    receiver_user_id,
    status,
    } = req.body;

  // 필수값 체크
  if (!requester_user_id || !receiver_user_id || !status) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `DELETE FROM friendships 
       WHERE requester_user_id=$1 AND receiver_user_id=$2
       RETURNING *`,
      [requester_user_id, receiver_user_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB 저장 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});

app.get('/friends', authenticateToken, async (req, res) => {
  const me = req.user.id;
  let client;
  try {
    client = await pool.connect();

    // 내 요청(requester) 혹은 내가 받은 요청(receiver) 모두 조회
    const result = await client.query(
      `
      SELECT
        f.friendships_id,
        f.requester_user_id,
        f.receiver_user_id,
        f.status,
        f.requested_at,
        f.responded_at,
        u.user_id   AS friend_user_id,
        u.nickname,
        u.profile_image_url
      FROM friendships f
      -- 상대방 정보를 users 테이블에서 join
      JOIN users u
        ON ( (f.requester_user_id = $1 AND u.user_id = f.receiver_user_id)
          OR (f.receiver_user_id = $1 AND u.user_id = f.requester_user_id) )
      WHERE (f.requester_user_id = $1 OR f.receiver_user_id = $1)
        AND f.status='accepted'
      ORDER BY f.requested_at DESC
      `,
      [me]
    );

    const friends = result.rows.map(row => ({
      friendshipId:       row.friendships_id,
      status:             row.status,               // 'pending', 'accepted', 'rejected'
      direction:          row.requester_user_id === me ? 'outgoing' : 'incoming',
      requestedAt:        row.requested_at,
      respondedAt:        row.responded_at,
      user: {
        userId:          row.friend_user_id,
        nickname:        row.nickname,
        profileImageUrl: row.profile_image_url,
      }
    }));

    res.json(friends);
  } catch (err) {
    console.error('GET /friends error:', err);
    res.status(500).json({ error: '친구 목록 조회 중 오류가 발생했습니다.' });
  } finally {
    if (client) client.release();
  }
});


// 두 포토 id 를 받아서 유사도를 알려주는 api
// 친구랑 비교할 때 사용
// user_photo_id와 friend_photo_id를 사용
// friend_photo_id 또한 user_photos에 들어가 있음
app.post('/friend_similarity', authenticateToken, async (req, res) => {
  const { user_photo_id, friend_photo_id } = req.body;

  if (!user_photo_id || !friend_photo_id) {
    return res.status(400).json({ error: 'user_photo_id와 friend_photo_id가 필요합니다.' });
  }

  let client;
  try {
    client = await pool.connect();

    // 1) 나(유저) 임베딩 벡터 조회
    const userQ = await client.query(
      'SELECT embedding_vector FROM user_photos WHERE user_photo_id = $1',
      [user_photo_id]
    );
    if (userQ.rows.length === 0) {
      return res.status(404).json({ error: '해당 user_photo_id를 찾을 수 없습니다.' });
    }
    const vecUser = userQ.rows[0].embedding_vector;

    // 2) 친구 임베딩 벡터 조회
    const friendQ = await client.query(
      'SELECT embedding_vector FROM user_photos WHERE user_photo_id = $1',
      [friend_photo_id]
    );
    if (friendQ.rows.length === 0) {
      return res.status(404).json({ error: '해당 friend_photo_id를 찾을 수 없습니다.' });
    }
    const vecFriend = friendQ.rows[0].embedding_vector;

    // 3) 코사인 유사도 계산
    const score = similarity(vecUser, vecFriend);      // -1 ~ 1
    const percent = Math.round(((score + 1) / 2) * 100); // 0 ~ 100

    // 4) 결과 응답
    res.json({ 
      user_photo_id, 
      friend_photo_id, 
      cosine_similarity: score, 
      similarity_percent: percent 
    });

  } catch (err) {
    console.error('compare_similarity error:', err);
    res.status(500).json({ error: '유사도 계산 중 오류가 발생했습니다.' });
  } finally {
    if (client) client.release();
  }
});


//--------------------------------------------------------------------------------
app.patch('/update_isonline', async (req, res) => {
  const { is_online, user_id } = req.body;

  if (!is_online) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `UPDATE users 
       SET is_online = $1
       WHERE user_id = $2 
       RETURNING *`,
      [
        is_online,
        user_id
      ]
    );

    res.json(
      result.rows[0]
    );
  } catch (err) {
    res.status(500).json({ error: '온라인 상태 업데이트 실패패' });
  } finally {
    if (client) client.release();
  }
});
//--------------------------------------------------------------------------
// DELETE /notifications/:notification_id
app.delete('/notifications/:notification_id', async (req, res) => {
  const { notification_id } = req.params;
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'DELETE FROM notifications WHERE notification_id = $1 RETURNING *',
      [notification_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '해당 알림을 찾을 수 없습니다.' });
    }
    res.json({ message: '알림이 성공적으로 삭제되었습니다.', deleted: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: '알림 삭제 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});
//-----------------------------------------------------------------------------------------
app.post('/latest-photo-similarity', async (req, res) => {
  const { user_id1, user_id2 } = req.body;
  if (!user_id1 || !user_id2) {
    return res.status(400).json({ error: 'user_id1, user_id2가 필요합니다.' });
  }

  let client;
  try {
    client = await pool.connect();

    // 각 유저의 최신 사진 1장 조회
    const getPhoto = async (user_id) => {
      const result = await client.query(
        `SELECT image_url, embedding_vector
         FROM user_photos
         WHERE user_id = $1
         ORDER BY uploaded_at DESC
         LIMIT 1`,
        [user_id]
      );
      return result.rows[0];
    };

    const photo1 = await getPhoto(user_id1);
    const photo2 = await getPhoto(user_id2);

    if (!photo1 || !photo2) {
      return res.status(404).json({ error: '두 유저 모두의 최신 사진이 필요합니다.' });
    }

    // 벡터 파싱 (Postgres vector → JS array)
    const parseVector = (vec) => {
      if (Array.isArray(vec)) {
        return vec.map(Number);
      }
      if (typeof vec === 'string') {
        try {
          return JSON.parse(vec);
        } catch (e) {
          console.error('벡터 JSON 파싱 실패, vec=', vec, e);
          return [];
        }
      }
      return [];
    };

    const vec1 = parseVector(photo1.embedding_vector);
    const vec2 = parseVector(photo2.embedding_vector);

    if (!Array.isArray(vec1) || !Array.isArray(vec2) || vec1.length !== vec2.length) {
      return res.status(400).json({ error: '임베딩 벡터 형식 오류' });
    }

    // cosine similarity 계산
    const score = similarity(vec1, vec2);

    res.json({
      cosine_similarity: score,
      user1_image_url: photo1.image_url,
      user2_image_url: photo2.image_url
    });
  } catch (err) {
    res.status(500).json({ error: '서버 오류', detail: err.message });
  } finally {
    if (client) client.release();
  }
});
//--------------------------------------------------------------------------------------
app.get('/contest-top3', async (req, res) => {
  const { contest_id } = req.query;
  if (!contest_id) {
    return res.status(400).json({ error: 'contest_id가 필요합니다.' });
  }

  let client;
  try {
    client = await pool.connect();

    // 1. 콘테스트에서 1,2,3등 user_id 조회
    const contestResult = await client.query(
      `SELECT first_user_id, second_user_id, third_user_id FROM contests WHERE contest_id = $1`,
      [contest_id]
    );
    if (contestResult.rows.length === 0) {
      return res.status(404).json({ error: '해당 콘테스트를 찾을 수 없습니다.' });
    }
    const { first_user_id, second_user_id, third_user_id } = contestResult.rows[0];

    // 2. 각 등수별 정보 추출 함수
    const getEntryInfo = async (user_id) => {
      if (!user_id) return null;
      // 2-1. contest_entries에서 해당 user의 entry 찾기
      const entry = await client.query(
        `SELECT similarity_score, user_photo_id FROM contest_entries
         WHERE contest_id = $1 AND user_id = $2
         ORDER BY similarity_score DESC LIMIT 1`,
        [contest_id, user_id]
      );
      if (entry.rows.length === 0) return null;
      const { similarity_score, user_photo_id } = entry.rows[0];

      // 2-2. user_photos에서 이미지 url 찾기
      const photo = await client.query(
        `SELECT image_url FROM user_photos WHERE user_photo_id = $1`,
        [user_photo_id]
      );
      const image_url = photo.rows.length > 0 ? photo.rows[0].image_url : null;

      return {
        user_id,
        similarity_score,
        user_photo_id,
        image_url,
      };
    };

    // 3. 1,2,3등 정보 병렬 조회
    const [first, second, third] = await Promise.all([
      getEntryInfo(first_user_id),
      getEntryInfo(second_user_id),
      getEntryInfo(third_user_id),
    ]);

    res.json({
      first: first || null,
      second: second || null,
      third: third || null,
    });
  } catch (err) {
    res.status(500).json({ error: '서버 오류', detail: err.message });
  } finally {
    if (client) client.release();
  }
});

app.get('/contest-entry-check', async (req, res) => {
  const { contest_id, user_id } = req.query;

  if (!contest_id || !user_id) {
    return res.status(400).json({ error: 'contest_id와 user_id가 필요합니다.' });
  }

  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT * FROM contest_entries WHERE contest_id = $1 AND user_id = $2 LIMIT 1`,
      [contest_id, user_id]
    );

    if (result.rows.length > 0) {
      res.json({
        exists: true,
        entry: result.rows[0]
      });
    } else {
      res.json({
        exists: false,
        entry: null
      });
    }
  } catch (err) {
    console.error('GET /contest-entry-check error:', err);
    res.status(500).json({ error: '참가 여부 조회 중 오류가 발생했습니다.' });
  } finally {
    if (client) client.release();
  }
});

app.get('/latest-user-photo-id/:user_id', async (req, res) => {
  const { user_id } = req.params;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id가 필요합니다.' });
  }
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT user_photo_id
         FROM user_photos
        WHERE user_id = $1
        ORDER BY uploaded_at DESC
        LIMIT 1`,
      [user_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '해당 유저의 사진이 없습니다.' });
    }
    res.json({ user_photo_id: result.rows[0].user_photo_id });
  } catch (err) {
    res.status(500).json({ error: 'DB 조회 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});


  // app.post('/getsimilarity', (req,res) => {
  //   const client = pool.connect();
  //   const meta = JSON.parse(req.body.meta);
  //   const vecA = meta.vec1; // 512차원 배열
  //   const vecB = meta.vec2; // 512차원 배열
  //   const score = similarity(vecA, vecB);
  //   const percent = ((score + 1) / 2) * 100
  //   console.log(percent); // -1 ~ 1 사이의 값
  //   client.query('INSERT INTO similarity_results (user_photo_id, target_type, target_photo_id, uploaded_photo_id, similarity_score, analyzed_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *',
  //       [meta.user_photo_id, meta.target_photo_id, meta.uploaded_photo_id, percent]);
  //   res.json({score:percent});
  //   }
  // );
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
