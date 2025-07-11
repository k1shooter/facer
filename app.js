//app.js
const REST_API_KEY=process.env.KAKAO_REST_API_KEY

const express = require("express");
const session = require("express-session");
const qs = require("qs");
const axios = require("axios");
const app = express();
const port = 4000;

// 정적 파일 서빙 설정 추가
app.use(express.static(__dirname));
app.use(express.json()); // JSON 파싱을 위해 추가

// 로그인 상태 유지를 위한 세션 설정
app.use(
  session({
    secret: "your session secret",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

// 변수 지정
const client_id = REST_API_KEY;               // 내 앱의 REST API 키로 변경 필수
// const client_secret = "this is client secret key";
const domain = "http://localhost:3000";
const redirect_uri = 'http://localhost:3000/auth/kakao';
const token_uri = "https://kauth.kakao.com/oauth/token"; // 액세스 토큰 요청을 보낼 카카오 인증 서버 주소 
const api_host = "https://kapi.kakao.com";               // 카카오 API 호출 서버 주소


// API 요청 함수 정의
async function call(method, uri, param, header) {
  let rtn;
  try {
    // 지정된 method, uri, param, header 값을 사용해 카카오 API 서버로 HTTP 요청 전송
    rtn = await axios({
      method: method,   // "POST" 또는 "GET" 등 HTTP 메서드
      url: uri,         // 요청할 API 주소
      headers: header,  // 요청 헤더 (예: Content-Type, Authorization 등)
      data: param,      // 전송할 요청 데이터 (body)
    });
  } catch (err) {
    // 오류 발생 시, 응답 객체에서 오류 응답 내용 저장
    rtn = err.response;
  }
  // 요청 성공 또는 실패에 상관없이 응답 데이터 반환
  return rtn.data;
}

//

// 카카오 인증 서버로 인가 코드 발급 요청
app.get("/authorize", function (req, res) {
  // 선택: 사용자에게 추가 동의를 요청하는 경우, scope 값으로 동의항목 ID를 전달
  // 친구 목록, 메시지 전송 등 접근권한 요청 가능
  // (예: /authorize?scope=friends,talk_message)
  let { scope } = req.query;
  let scopeParam = "";
  if (scope) {
    scopeParam = "&scope=" + scope;
  }

  // 카카오 인증 서버로 리다이렉트
  // 사용자 동의 후 리다이렉트 URI로 인가 코드가 전달
  res.status(302).redirect(
      `https://kauth.kakao.com/oauth/authorize?client_id=${client_id}&redirect_uri=${redirect_uri}&response_type=code${scopeParam}`
  );
});

//
// 카카오 인증 서버에서 전달받은 인가 코드로 액세스 토큰 발급 요청
app.get("/redirect", async function (req, res) {
  // 인가 코드 발급 요청에 필요한 파라미터 구성
  const param = qs.stringify({
    grant_type: "authorization_code",   // 인증 방식 고정값
    client_id: client_id,               // 내 앱의 REST API 키
    redirect_uri: redirect_uri,         // 등록된 리다이렉트 URI
    code: req.query.code,               // 전달받은 인가 코드
    // client_secret: client_secret,       // 선택: 클라이언트 시크릿(Client Secret) 사용 시 추가
  });

  // API 요청 헤더 설정
  const header = { "content-type": "application/x-www-form-urlencoded" };

  // 카카오 인증 서버에 액세스 토큰 요청
  const rtn = await call("POST", token_uri, param, header);

  // 발급받은 액세스 토큰을 세션에 저장 (로그인 상태 유지 목적)
  req.session.key = rtn.access_token;

  // 로그인 완료 후 메인 페이지로 이동
  res.status(302).redirect(`${domain}/index.html?login=success`);
});

//

// 액세스 토큰을 사용해 로그인한 사용자의 정보 조회 요청
app.get("/profile", async function (req, res) {
  const uri = api_host + "/v2/user/me";  // 사용자 정보 가져오기 API 주소
  const param = {};  // 사용자 정보 요청 시 파라미터는 필요 없음
  const header = {
    "content-type": "application/x-www-form-urlencoded",  // 요청 헤더 Content-Type 지정
    Authorization: "Bearer " + req.session.key,  // 세션에 저장된 액세스 토큰 전달
  };

  const rtn = await call("POST", uri, param, header);  // 카카오 API에 요청 전송

  res.send(rtn);  // 조회한 사용자 정보를 클라이언트에 반환
});

//

// 로그아웃 요청: 세션을 종료하고 사용자 로그아웃 처리
app.get("/logout", async function (req, res) {
  const uri = api_host + "/v1/user/logout";  // 로그아웃 API 주소
  const header = {
    Authorization: "Bearer " + req.session.key  // 세션에 저장된 액세스 토큰 전달
  };

  const rtn = await call("POST", uri, null, header);  // 카카오 API에 로그아웃 요청 전송
  req.session.destroy();  // 세션 삭제 (로그아웃 처리)
  res.send(rtn);  // 응답 결과 클라이언트에 반환
});

// 연결 끊기 요청: 사용자와 앱의 연결을 해제하고 세션 종료
app.get("/unlink", async function (req, res) {
  const uri = api_host + "/v1/user/unlink";  // 연결 끊기 API 주소
  const header = {
    Authorization: "Bearer " + req.session.key  // 세션에 저장된 액세스 토큰 전달
  };

  const rtn = await call("POST", uri, null, header);  // 카카오 API에 연결 끊기 요청 전송
  req.session.destroy();  // 세션 삭제 (연결 해제 처리)
  res.send(rtn);  // 응답 결과 클라이언트에 반환
});

//

app.listen(port, () => {
  console.log(`Server is running at ${domain}`);
});