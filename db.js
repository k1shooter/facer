// app.js 또는 db.js 등 연결을 관리하는 파일
require('dotenv').config(); // .env 파일의 환경 변수 로드

const { Pool } = require('pg');

// 환경 변수에서 DB 연결 정보 가져오기
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// 데이터베이스 연결 테스트 함수 (선택 사항)
async function testDbConnection() {
  try {
    const client = await pool.connect();
    console.log('Database connected successfully!');

    client.release(); // 클라이언트 반환
  } catch (err) {
    console.error('Database connection error:', err.stack);
  }
}

// 애플리케이션 시작 시 DB 연결 테스트
testDbConnection();

// pool 객체를 다른 모듈에서 사용할 수 있도록 export
module.exports = pool;