// db.js
require('dotenv').config(); // .env 파일의 환경 변수를 로드

const { Client } = require('pg'); // PostgreSQL 클라이언트 모듈 임포트

// PostgreSQL 연결 설정 (환경 변수 사용)
const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false // 프로덕션 환경에서만 SSL 활성화
});

// 데이터베이스 연결 및 테이블 초기화 함수
async function connectDbAndInitialize() {
    try {
        await client.connect(); // 데이터베이스 연결 시도
        console.log('PostgreSQL connected successfully!');

        // users 테이블 생성 (이미 존재하면 건너김)
        // kakao_id를 고유 식별자로 사용하고, email은 선택 사항으로 변경
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                kakao_id BIGINT UNIQUE NOT NULL, -- 카카오 고유 ID (long 타입)
                name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Users table checked/created successfully!');

    } catch (err) {
        console.error('Failed to connect to PostgreSQL or initialize database:', err.stack);
        // 앱 종료 또는 다른 오류 처리 로직 추가 가능
        process.exit(1); // 오류 발생 시 Node.js 프로세스 종료
    }
}

// 모듈 내보내기
module.exports = {
    query: (text, params) => client.query(text, params), // 쿼리 실행 함수 내보내기
    connectDbAndInitialize: connectDbAndInitialize, // DB 연결 및 초기화 함수 내보내기
    client: client // 필요하다면 client 객체 자체를 내보내기 (권장되지는 않음)
};

// 서버 시작 시 DB 연결 및 초기화 함수 호출
// (server.js에서 require('./db');를 하면 이 부분이 실행됨)
connectDbAndInitialize();
