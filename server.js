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

app.post('/contestsadd', async (req, res) => {
  const {
    target_type,
    target_name,
    target_photo_id,
    title,
    description,
    status
  } = req.body;

  // 필수값 체크
  if (!target_type || !target_name || !target_photo_id || !title || !description || !status) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `INSERT INTO contests 
        (target_type, target_name, target_photo_id, title, description, status, start_date)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [target_type, target_name, target_photo_id, title, description, status]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB 저장 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});

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
      `SELECT embedding_vector FROM contests WHERE contest_id = $1`,[contest_id]
    );
    const getter2=await client.query(
      `SELECT embedding_vector FROM user_photos WHERE user_id = $1 AND user_photo_id = $2`,[user_id, user_photo_id]
    );

    const vec1 = getter.rows[0].embedding_vector; // 예: [0.1, 0.2, ...]
    const vec2 = getter2.rows[0].embedding_vector;

    similarity_score = similarity(vec1, vec2);


    const result = await client.query(
      `INSERT INTO contest_entries 
        (contest_id, user_id, user_photo_id, similarity_score, submitted_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [contest_id, user_id, user_photo_id, similarity_score]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB 저장 중 오류 발생' });
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

//---------------------------------------------------------------------------------
app.post('/notification_add', async (req, res) => {
  const {
    user_id,
    type,
    message} = req.body;

  // 필수값 체크
  if (!user_id || !type || !message) {
    return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
  }

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `INSERT INTO notifications 
        (user_id, type, message, is_read, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [user_id, type, message, false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB 저장 중 오류 발생' });
  } finally {
    if (client) client.release();
  }
});

app.post('/friendship_add', async (req, res) => {
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
      `INSERT INTO friendships 
        (requester_user_id, receiver_user_id, status, requested_at, responded_at)
       VALUES ($1, $2, $3, NOW(), NULL)
       RETURNING *`,
      [requester_user_id, receiver_user_id, status, false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'DB 저장 중 오류 발생' });
  } finally {
    if (client) client.release();
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
