// 사파리 공유 시트 → iOS 단축어에서 GET으로 호출해서 북마크를 바로 등록하는 전용 통로.
// 사이트 비밀번호(SITE_PASSWORD)와는 별개로, 이 통로만을 위한 SHORTCUT_SECRET로 인증해요.
//
// 사용법: GET /api/quick-bookmark?key=SHORTCUT_SECRET&title=제목&url=https://...
//
// 필요한 환경변수:
//   SHORTCUT_SECRET      — 단축어 전용 비밀키 (아무 문자열, 사이트 비밀번호랑 다르게)
//   NOTION_SECRET         — 이미 있는 노션 통합 시크릿
//   NOTION_DATABASE_ID_BOOKMARK — 이미 있는 북마크 데이터베이스 ID

const NOTION_VERSION = '2022-06-28';

function notionHeaders() {
  return {
    'Authorization': `Bearer ${process.env.NOTION_SECRET}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

module.exports = async (req, res) => {
  const SECRET = process.env.SHORTCUT_SECRET;
  if (!SECRET) {
    res.status(500).send('SHORTCUT_SECRET 환경변수가 설정되지 않았어요.');
    return;
  }
  const { key, title, url } = req.query || {};
  if (key !== SECRET) {
    res.status(403).send('키가 올바르지 않아요.');
    return;
  }
  if (!title || !url) {
    res.status(400).send('title과 url이 필요해요.');
    return;
  }

  const databaseId = process.env.NOTION_DATABASE_ID_BOOKMARK;
  if (!databaseId) {
    res.status(500).send('NOTION_DATABASE_ID_BOOKMARK 환경변수가 설정되지 않았어요.');
    return;
  }

  try {
    const properties = {
      'Name': { title: [{ text: { content: String(title).slice(0, 200) } }] },
      'URL': { url: String(url) },
      'Subtitle': { rich_text: [] },
      'App ID': { rich_text: [{ text: { content: Date.now().toString() } }] },
      'Last Updated': { date: { start: new Date().toISOString() } }
    };
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify({ parent: { database_id: databaseId }, properties })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || '노션 저장 실패');

    res.status(200).send('✅ 북마크에 저장했어요: ' + title);
  } catch (err) {
    res.status(500).send('저장 실패: ' + (err.message || '알 수 없는 오류'));
  }
};
