require('dotenv').config(); // .env 파일 로드

const { Pool } = require('pg');

// 데이터베이스 연결 설정
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

module.exports = {
    query: (text, params) => pool.query(text, params), // 이 부분이 중요!
};