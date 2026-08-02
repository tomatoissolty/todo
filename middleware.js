// 사이트 전체(Daily, REEL, 앞으로 만들 일기 앱까지 전부)에 비밀번호를 걸어주는
// 무료 미들웨어예요. Vercel의 공식 "Password Protection"은 월 $150 유료 애드온이라
// 대신 이 방식을 써요 — 완전히 무료고, 개인 프로젝트(Hobby) 플랜에서도 잘 작동해요.
//
// 필요한 환경변수:
//   SITE_PASSWORD — 원하는 비밀번호 아무거나 (예: 본인만 아는 짧은 문구)
//
// 작동 방식: 브라우저에 인증 쿠키가 없으면 비밀번호 입력 화면을 보여주고,
// 맞으면 30일짜리 쿠키를 심어서 그 이후엔 안 물어봐요.

export const config = { matcher: '/:path*' };

const COOKIE_NAME = 'site_auth';

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>비밀번호 확인</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0c0c0c;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  form{background:#161616;padding:32px;border-radius:16px;width:280px;text-align:center;border:1px solid #2a2a2a}
  .icon{font-size:26px;margin-bottom:8px}
  .label{font-size:13px;color:#888;margin-bottom:4px}
  input{width:100%;padding:12px;margin-top:14px;border-radius:8px;border:1px solid #333;background:#1e1e1e;color:#eee;font-size:15px;box-sizing:border-box;outline:none}
  input:focus{border-color:#d4a843}
  button{width:100%;margin-top:12px;padding:12px;border-radius:8px;border:none;background:#d4a843;color:#111;font-weight:600;cursor:pointer;font-size:14px}
  p.err{color:#e74c3c;font-size:12px;margin-top:10px}
</style>
</head>
<body>
  <form method="POST" action="/__auth">
    <div class="icon">🔒</div>
    <div class="label">비밀번호를 입력하세요</div>
    <input type="password" name="password" autofocus required autocomplete="current-password">
    <button type="submit">입장</button>
    ${error ? '<p class="err">비밀번호가 틀렸어요</p>' : ''}
  </form>
</body>
</html>`;
}

export default async function middleware(request) {
  const url = new URL(request.url);

  // 단축어(Shortcuts) 전용 통로는 사이트 비밀번호 화면을 안 거치고 바로 통과 —
  // 대신 그 안에서 자체 비밀키(SHORTCUT_SECRET)로 따로 확인해요.
  if (url.pathname === '/api/quick-bookmark') return;

  const SITE_PASSWORD = process.env.SITE_PASSWORD;

  // 비밀번호가 아직 설정 안 됐으면(설정 전 실수로 잠기는 걸 막기 위해) 그냥 통과시켜요.
  if (!SITE_PASSWORD) return;

  const expected = await sha256(SITE_PASSWORD);
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([a-f0-9]+)`));
  if (match && match[1] === expected) {
    return; // 인증된 방문자 — 그대로 통과
  }

  // 로그인 폼 제출 처리
  if (request.method === 'POST' && url.pathname === '/__auth') {
    const form = await request.formData();
    const pw = form.get('password') || '';
    if (pw === SITE_PASSWORD) {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': `${COOKIE_NAME}=${expected}; Path=/; HttpOnly; Secure; Max-Age=2592000; SameSite=Lax`
        }
      });
    }
    return new Response(loginPage(true), {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }

  // 인증 안 된 모든 요청 — 로그인 화면 보여주기
  return new Response(loginPage(false), {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}
