// Daily 앱 ↔ 노션 양방향 동기화 프록시
// 노션 시크릿 키는 여기(서버) 환경변수에만 있고, 브라우저에는 절대 노출되지 않아요.
//
// 필요한 환경변수 (Vercel 프로젝트 Settings → Environment Variables):
//   NOTION_SECRET       — 노션 인테그레이션의 Internal Integration Secret
//   NOTION_DATABASE_ID  — "✅ Daily 할 일" 데이터베이스의 ID
//
// GET  /api/notion   → 노션 DB의 모든 항목을 가져옴 (pull)
// POST /api/notion    → 로컬 항목들을 노션에 생성/수정함 (push), body: { items: [...] }

const NOTION_VERSION = '2022-06-28';

function notionHeaders() {
  return {
    'Authorization': `Bearer ${process.env.NOTION_SECRET}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

// 로컬 todo 항목 → 노션 페이지 속성으로 변환
function toNotionProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'Date': item.date ? { date: { start: item.date } } : { date: null },
    'Completed': { checkbox: !!item.completed },
    'Category': { rich_text: item.category ? [{ text: { content: item.category } }] : [] },
    'Routine': { checkbox: !!item.routine },
    'Subtasks': { rich_text: item.subtasks ? [{ text: { content: item.subtasks } }] : [] },
    'App ID': { rich_text: [{ text: { content: String(item.appId || '') } }] },
    'Last Updated': item.updatedAt ? { date: { start: item.updatedAt } } : { date: null }
  };
}

// 노션 페이지 → 앱이 이해하는 형태로 변환
function fromNotionPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  return {
    notionPageId: page.id,
    appId: richText(p['App ID']),
    name: titleText(p['Name']),
    date: p['Date']?.date?.start || null,
    completed: !!p['Completed']?.checkbox,
    category: richText(p['Category']),
    routine: !!p['Routine']?.checkbox,
    subtasks: richText(p['Subtasks']),
    lastUpdated: p['Last Updated']?.date?.start || null
  };
}

module.exports = async (req, res) => {
  const { NOTION_SECRET, NOTION_DATABASE_ID } = process.env;
  if (!NOTION_SECRET || !NOTION_DATABASE_ID) {
    res.status(500).json({ error: 'NOTION_SECRET 또는 NOTION_DATABASE_ID 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정에서 등록해주세요.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      let items = [];
      let cursor;
      do {
        const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
          method: 'POST',
          headers: notionHeaders(),
          body: JSON.stringify(cursor ? { start_cursor: cursor } : {})
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || '노션 조회 실패');
        items = items.concat((data.results || []).map(fromNotionPage));
        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST') {
      const items = req.body && req.body.items;
      if (!Array.isArray(items)) {
        res.status(400).json({ error: 'items 배열이 필요해요.' });
        return;
      }
      const results = [];
      for (const item of items) {
        const properties = toNotionProperties(item);
        if (item.notionPageId) {
          const r = await fetch(`https://api.notion.com/v1/pages/${item.notionPageId}`, {
            method: 'PATCH',
            headers: notionHeaders(),
            // archived:false 는 undo(되돌리기)로 되살아난 항목이 노션에서도 자동 복원되게 해줘요
            body: JSON.stringify({ properties, archived: false })
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.message || '노션 업데이트 실패');
          results.push({ appId: item.appId, notionPageId: data.id });
        } else {
          const r = await fetch('https://api.notion.com/v1/pages', {
            method: 'POST',
            headers: notionHeaders(),
            body: JSON.stringify({ parent: { database_id: NOTION_DATABASE_ID }, properties })
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.message || '노션 생성 실패');
          results.push({ appId: item.appId, notionPageId: data.id });
        }
      }
      res.status(200).json({ results });
      return;
    }

    if (req.method === 'DELETE') {
      const pageId = req.body && req.body.pageId;
      if (!pageId) {
        res.status(400).json({ error: 'pageId가 필요해요.' });
        return;
      }
      const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: notionHeaders(),
        body: JSON.stringify({ archived: true })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || '노션 삭제 실패');
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: '지원하지 않는 요청 방식이에요.' });
  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류가 발생했어요.' });
  }
};
