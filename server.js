// server.js

// 1. 필요한 모듈 임포트
const express = require('express'); // 웹 서버 프레임워크
const dotenv = require('dotenv');   // 환경 변수 로드
const { Pool } = require('pg');     // PostgreSQL 클라이언트

// 2. 환경 변수 로드 (.env 파일에서)
dotenv.config();

// 3. Express 애플리케이션 초기화
const app = express();
const port = process.env.PORT || 3000; // 환경 변수에 PORT가 없으면 3000번 포트 사용

// 4. 미들웨어 설정
app.use(express.json()); // JSON 형식의 요청 본문(body)을 파싱하기 위함

// 5. PostgreSQL 데이터베이스 연결 설정
// 환경 변수에서 DB 연결 정보 가져오기
const pool = new Pool({
  user: process.env.DB_USER,        // .env 파일의 DB_USER (예: sk)
  host: process.env.DB_HOST,        // .env 파일의 DB_HOST (Docker Compose 사용 시 'facer', 직접 실행 시 'localhost')
  database: process.env.DB_NAME,    // .env 파일의 DB_NAME (예: facer_db)
  password: process.env.DB_PASSWORD,// .env 파일의 DB_PASSWORD (예: madcamp@2025)
  port: process.env.DB_PORT,        // .env 파일의 DB_PORT (기본 5432)
});

// 데이터베이스 연결 테스트 함수
async function testDbConnection() {
  try {
    const client = await pool.connect(); // DB 연결 시도
    console.log('✅ Database connected successfully!');

    // pgvector 확장 활성화 확인 (선택 사항: 이미 Docker exec로 활성화했다면 필요 없음)
    const res = await client.query('SELECT 1 FROM pg_extension WHERE extname = \'vector\';');
    if (res.rows.length > 0) {
      console.log('✅ pgvector extension is active.');
    } else {
      console.warn('⚠️ pgvector extension is NOT active. Please run CREATE EXTENSION IF NOT EXISTS vector;');
    }

    client.release(); // 사용한 클라이언트를 풀에 반환
  } catch (err) {
    console.error('❌ Database connection error:', err.stack);
  }
}

// 6. API 엔드포인트 정의

// 기본 라우트 (루트 경로)
app.get('/', (req, res) => {
  res.status(200).send('Welcome to the Facer Node.js Backend!');
});

// 테스트 API 엔드포인트
app.get('/api/test', (req, res) => {
  res.status(200).json({
    message: 'Hello from Node.js Backend on VM!',
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// 데이터베이스 연결 테스트 API (DB 연결이 잘 되었는지 확인)
app.get('/api/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time');
    client.release();
    res.status(200).json({
      message: 'Database connection successful!',
      currentTime: result.rows[0].current_time
    });
  } catch (error) {
    console.error('Error connecting to database via API:', error);
    res.status(500).json({
      message: 'Failed to connect to database.',
      error: error.message
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Node.js app listening on port ${port} on all interfaces (0.0.0.0)`);
  console.log(`Access it at http://localhost:${port} (if running locally)`);
  console.log(`Or via VM IP: http://[YOUR_VM_IP_ADDRESS]:${port}`);

  // 서버 시작 후 DB 연결 테스트 실행
  testDbConnection();
});