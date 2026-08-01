// 여러 앱(Daily 할 일, REEL 영화 기록 등)이 공유하는 노션 동기화 프록시
// 노션 시크릿 키는 여기(서버) 환경변수에만 있고, 브라우저에는 절대 노출되지 않아요.
//
// 필요한 환경변수 (Vercel 프로젝트 Settings → Environment Variables):
//   NOTION_SECRET            — 노션 인테그레이션의 Internal Integration Secret (공용)
//   NOTION_DATABASE_ID       — "✅ Daily 할 일" 데이터베이스 ID (todo 앱, 기존 이름 유지)
//   NOTION_DATABASE_ID_MOVIE — "🎬 REEL 영화 기록" 데이터베이스 ID
//
// 사용법: /api/notion?app=todo  또는  /api/notion?app=movie  (app 생략 시 todo)
//   GET    → 해당 DB의 모든 항목을 가져옴 (pull)
//   POST   → 로컬 항목들을 생성/수정함 (push), body: { items: [...] }
//   DELETE → 페이지 하나를 보관 처리(삭제)함, body: { pageId }

const NOTION_VERSION = '2022-06-28';

function notionHeaders() {
  return {
    'Authorization': `Bearer ${process.env.NOTION_SECRET}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

// --- Todo(Daily 앱) 매핑 ---
function todoToProperties(item) {
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
function todoFromPage(page) {
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

// --- Movie(REEL 앱) 매핑 ---
function movieToProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'Poster': item.poster ? { url: item.poster } : { url: null },
    // 갤러리 뷰의 카드 이미지는 Files & media 속성에서 가져오므로 Cover 필드도 함께 채운다
    'Cover': item.poster ? { files: [{ name: 'poster.jpg', type: 'external', external: { url: item.poster } }] } : { files: [] },
    'Rating': { number: typeof item.rating === 'number' ? item.rating : null },
    'Status': item.status ? { select: { name: item.status } } : { select: null },
    'Genre': { rich_text: item.genre ? [{ text: { content: item.genre } }] : [] },
    'Year': { number: item.year || null },
    'Type': item.type ? { select: { name: item.type } } : { select: null },
    'Review': { rich_text: item.review ? [{ text: { content: item.review } }] : [] },
    'App ID': { rich_text: [{ text: { content: String(item.appId || '') } }] },
    'Last Updated': item.updatedAt ? { date: { start: item.updatedAt } } : { date: null }
  };
}
function movieFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  return {
    notionPageId: page.id,
    appId: richText(p['App ID']),
    name: titleText(p['Name']),
    poster: p['Poster']?.url || null,
    rating: typeof p['Rating']?.number === 'number' ? p['Rating'].number : 0,
    status: p['Status']?.select?.name || null,
    genre: richText(p['Genre']),
    year: p['Year']?.number || null,
    type: p['Type']?.select?.name || null,
    review: richText(p['Review']),
    lastUpdated: p['Last Updated']?.date?.start || null
  };
}

const APPS = {
  todo: {
    databaseId: () => process.env.NOTION_DATABASE_ID_TODO || process.env.NOTION_DATABASE_ID,
    toProperties: todoToProperties,
    fromPage: todoFromPage,
    useCover: false
  },
  movie: {
    databaseId: () => process.env.NOTION_DATABASE_ID_MOVIE,
    toProperties: movieToProperties,
    fromPage: movieFromPage,
    useCover: true // 포스터를 노션 페이지 커버로도 설정해서 갤러리 뷰에서 예쁘게 보이게 함
  }
};

module.exports = async (req, res) => {
  const appKey = (req.query && req.query.app) || 'todo';
  const appConfig = APPS[appKey];
  if (!appConfig) {
    res.status(400).json({ error: `알 수 없는 app 값이에요: ${appKey}` });
    return;
  }

  const NOTION_SECRET = process.env.NOTION_SECRET;
  const databaseId = appConfig.databaseId();
  if (!NOTION_SECRET || !databaseId) {
    res.status(500).json({ error: `이 앱(${appKey})에 필요한 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정에서 등록해주세요.` });
    return;
  }

  try {
    if (req.method === 'GET') {
      let items = [];
      let cursor;
      do {
        const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
          method: 'POST',
          headers: notionHeaders(),
          body: JSON.stringify(cursor ? { start_cursor: cursor } : {})
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || '노션 조회 실패');
        items = items.concat((data.results || []).map(appConfig.fromPage));
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
        const properties = appConfig.toProperties(item);
        const coverBody = appConfig.useCover && item.poster
          ? { cover: { type: 'external', external: { url: item.poster } } }
          : {};
        if (item.notionPageId) {
          const r = await fetch(`https://api.notion.com/v1/pages/${item.notionPageId}`, {
            method: 'PATCH',
            headers: notionHeaders(),
            // archived:false 는 undo(되돌리기)로 되살아난 항목이 노션에서도 자동 복원되게 해줘요
            body: JSON.stringify({ properties, archived: false, ...coverBody })
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.message || '노션 업데이트 실패');
          results.push({ appId: item.appId, notionPageId: data.id });
        } else {
          const r = await fetch('https://api.notion.com/v1/pages', {
            method: 'POST',
            headers: notionHeaders(),
            body: JSON.stringify({ parent: { database_id: databaseId }, properties, ...coverBody })
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
