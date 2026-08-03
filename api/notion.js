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
    'Deferred': { checkbox: !!item.deferred },
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
    deferred: !!p['Deferred']?.checkbox,
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

// --- Diary(일기 앱) 매핑 — 본문/사진은 속성이 아니라 페이지 내용(블록)으로 들어감 ---
function diaryToProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'Date': item.date ? { date: { start: item.date } } : { date: null },
    'Locked': { checkbox: !!item.locked },
    'App ID': { rich_text: [{ text: { content: String(item.appId || '') } }] },
    'Last Updated': item.updatedAt ? { date: { start: item.updatedAt } } : { date: null }
  };
}

function diaryFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  return {
    notionPageId: page.id,
    appId: richText(p['App ID']),
    name: titleText(p['Name']),
    date: p['Date']?.date?.start || null,
    locked: !!p['Locked']?.checkbox,
    lastUpdated: p['Last Updated']?.date?.start || null
  };
}

// 노션 페이지 본문 블록을 앱이 이해하는 content 배열로 변환 (문단→글, 이미지→사진 URL)
async function fetchDiaryContent(pageId) {
  let blocks = [];
  let cursor;
  do {
    const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`;
    const r = await fetch(url, { headers: notionHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || '본문 조회 실패');
    blocks = blocks.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return blocks.map(b => {
    if (b.type === 'image') {
      const img = b.image || {};
      const url = (img.file && img.file.url) || (img.external && img.external.url) || null;
      return { type: 'photo', url };
    }
    const text = ((b.paragraph && b.paragraph.rich_text) || []).map(t => t.plain_text).join('');
    return { type: 'text', text };
  }).filter(seg => seg.type === 'photo' ? !!seg.url : true);
}

function buildDiaryBlocks(content) {
  return (content || []).map(seg => {
    if (seg.type === 'photo' && seg.fileUploadId) {
      return { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: seg.fileUploadId } } };
    }
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: seg.text ? [{ type: 'text', text: { content: seg.text } }] : [] } };
  });
}

// 페이지 본문을 완전히 새 내용으로 교체 (기존 블록 삭제 후 재작성)
async function replaceDiaryContent(pageId, blocks) {
  let cursor;
  do {
    const listUrl = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`;
    const r = await fetch(listUrl, { headers: notionHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || '기존 내용 조회 실패');
    for (const block of data.results || []) {
      await fetch(`https://api.notion.com/v1/blocks/${block.id}`, { method: 'DELETE', headers: notionHeaders() });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  if (blocks.length) {
    const r2 = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: notionHeaders(),
      body: JSON.stringify({ children: blocks })
    });
    const data2 = await r2.json();
    if (!r2.ok) throw new Error(data2.message || '본문 저장 실패');
  }
}

// 사진을 노션 "자체" 비공개 저장소에 직접 업로드 (외부 공개 호스팅 절대 사용 안 함)
async function uploadFileToNotion(dataUrl) {
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) throw new Error('올바르지 않은 이미지 데이터예요');
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');

  const createRes = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify({})
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(createData.message || '파일 업로드 생성 실패');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), 'photo.jpg');
  const sendRes = await fetch(createData.upload_url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_SECRET}`,
      'Notion-Version': NOTION_VERSION
    },
    body: form
  });
  const sendData = await sendRes.json();
  if (!sendRes.ok) throw new Error(sendData.message || '파일 업로드 전송 실패');
  return createData.id;
}


// --- Book(SHELF 독서 기록 앱) 매핑 ---
function bookToProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'Author': { rich_text: item.author ? [{ text: { content: item.author } }] : [] },
    'Publisher': { rich_text: item.publisher ? [{ text: { content: item.publisher } }] : [] },
    'Cover': item.cover ? { files: [{ name: 'cover.jpg', type: 'external', external: { url: item.cover } }] } : { files: [] },
    'ISBN': { rich_text: item.isbn ? [{ text: { content: item.isbn } }] : [] },
    'Rating': { number: typeof item.rating === 'number' ? item.rating : null },
    'Status': item.status ? { select: { name: item.status } } : { select: null },
    'Review': { rich_text: item.review ? [{ text: { content: item.review } }] : [] },
    'App ID': { rich_text: [{ text: { content: String(item.appId || '') } }] },
    'Last Updated': item.updatedAt ? { date: { start: item.updatedAt } } : { date: null }
  };
}
function bookFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  const fileUrl = (prop) => { const f = (prop?.files || [])[0]; if (!f) return null; return (f.file && f.file.url) || (f.external && f.external.url) || null; };
  return {
    notionPageId: page.id,
    appId: richText(p['App ID']),
    name: titleText(p['Name']),
    author: richText(p['Author']),
    publisher: richText(p['Publisher']),
    cover: fileUrl(p['Cover']),
    isbn: richText(p['ISBN']),
    rating: typeof p['Rating']?.number === 'number' ? p['Rating'].number : 0,
    status: p['Status']?.select?.name || null,
    review: richText(p['Review']),
    lastUpdated: p['Last Updated']?.date?.start || null
  };
}


// --- Bookmark(북마크 앱) 매핑 — 수정/삭제는 노션에서만, 앱은 추가+목록 조회만 함 ---
function bookmarkToProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'URL': { url: item.url || null },
    'Subtitle': { rich_text: item.subtitle ? [{ text: { content: item.subtitle } }] : [] },
    'Cover': item.coverFileUploadId ? { files: [{ name: 'ref.jpg', type: 'file_upload', file_upload: { id: item.coverFileUploadId } }] } : { files: [] },
    'App ID': { rich_text: [{ text: { content: String(item.appId || '') } }] },
    'Last Updated': item.updatedAt ? { date: { start: item.updatedAt } } : { date: null }
  };
}
function bookmarkFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  const fileUrl = (prop) => { const f = (prop?.files || [])[0]; if (!f) return null; return (f.file && f.file.url) || (f.external && f.external.url) || null; };
  return {
    notionPageId: page.id,
    appId: richText(p['App ID']),
    name: titleText(p['Name']),
    url: p['URL']?.url || '',
    subtitle: richText(p['Subtitle']),
    cover: fileUrl(p['Cover']),
    createdTime: page.created_time || null,
    lastUpdated: p['Last Updated']?.date?.start || null
  };
}


// --- Profile(홈 프로필 - 딱 한 개 글만 씀) / Gallery(홈 갤러리) 매핑 — 둘 다 pull(읽기) 전용 ---
function profileFromPage(page) {
  const p = page.properties || {};
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  const fileUrl = (prop) => { const f = (prop?.files || [])[0]; if (!f) return null; return (f.file && f.file.url) || (f.external && f.external.url) || null; };
  return {
    notionPageId: page.id,
    name: titleText(p['Name']),
    headerImage: fileUrl(p['Header Image']),
    mainImage: fileUrl(p['Main Image']),
    imagePosition: p['Image Position']?.select?.name || 'Center'
  };
}
// 페이지 본문(블록)을 훑어서 제일 처음 나오는 이미지 블록의 URL을 찾아줌
async function fetchFirstImageBlockUrl(pageId) {
  const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=20`, { headers: notionHeaders() });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || '본문 조회 실패');
  for (const block of data.results || []) {
    if (block.type === 'image') {
      const img = block.image || {};
      const url = (img.file && img.file.url) || (img.external && img.external.url) || null;
      if (url) return url;
    }
  }
  return null;
}

function galleryFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const fileUrl = (prop) => { const f = (prop?.files || [])[0]; if (!f) return null; return (f.file && f.file.url) || (f.external && f.external.url) || null; };
  return {
    notionPageId: page.id,
    photo: fileUrl(p['Photo']),
    caption: richText(p['Caption']),
    createdTime: page.created_time || null
  };
}


function calendarFromPage(page) {
  const p = page.properties || {};
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  return {
    notionPageId: page.id,
    name: titleText(p['Name']),
    start: p['Date']?.date?.start || null,
    end: p['Date']?.date?.end || null
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
  },
  diary: {
    databaseId: () => process.env.NOTION_DATABASE_ID_DIARY,
    toProperties: diaryToProperties,
    fromPage: diaryFromPage,
    useCover: false
  },
  book: {
    databaseId: () => process.env.NOTION_DATABASE_ID_BOOK,
    toProperties: bookToProperties,
    fromPage: bookFromPage,
    useCover: false // 표지는 Cover 파일 속성에 직접 넣으므로 페이지 커버는 따로 안 씀
  },
  bookmark: {
    databaseId: () => process.env.NOTION_DATABASE_ID_BOOKMARK,
    toProperties: bookmarkToProperties,
    fromPage: bookmarkFromPage, // 북마크는 노션이 원본이라 목록을 항상 pull(GET)로 가져와요
    useCover: false
  },
  profile: {
    databaseId: () => process.env.NOTION_DATABASE_ID_PROFILE,
    toProperties: null, // 읽기 전용 - 앱에서 글을 만들거나 고치지 않음
    fromPage: profileFromPage,
    useCover: false
  },
  gallery: {
    databaseId: () => process.env.NOTION_DATABASE_ID_GALLERY,
    toProperties: null,
    fromPage: galleryFromPage,
    useCover: false
  },
  calendar: {
    databaseId: () => process.env.NOTION_DATABASE_ID_CALENDAR,
    toProperties: null, // 읽기 전용 - 일정은 Notion Calendar 앱에서 만듦
    fromPage: calendarFromPage,
    useCover: false
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
    // --- 사진/파일을 노션 자체 저장소로 업로드 (여러 앱이 공용으로 씀) ---
    if (req.method === 'POST' && req.query.action === 'upload') {
      const dataUrl = req.body && req.body.dataUrl;
      if (!dataUrl) { res.status(400).json({ error: 'dataUrl이 필요해요.' }); return; }
      const fileUploadId = await uploadFileToNotion(dataUrl);
      res.status(200).json({ fileUploadId });
      return;
    }

    // --- 일기 앱 전용 처리: 항목 하나 저장(속성 + 본문 블록) ---
    if (appKey === 'diary' && req.method === 'POST' && !req.query.action) {
      const item = req.body && req.body.item;
      if (!item) { res.status(400).json({ error: 'item이 필요해요.' }); return; }
      const properties = appConfig.toProperties(item);
      let pageId = item.notionPageId;
      if (pageId) {
        const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          method: 'PATCH',
          headers: notionHeaders(),
          body: JSON.stringify({ properties, archived: false })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || '일기 업데이트 실패');
      } else {
        const r = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: notionHeaders(),
          body: JSON.stringify({ parent: { database_id: databaseId }, properties })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || '일기 생성 실패');
        pageId = data.id;
      }
      await replaceDiaryContent(pageId, buildDiaryBlocks(item.content));
      res.status(200).json({ notionPageId: pageId });
      return;
    }

    // --- 일기 앱 전용 처리: 특정 페이지의 본문 내용 가져오기 (pull 시 사용) ---
    if (appKey === 'diary' && req.method === 'GET' && req.query.action === 'content') {
      const pageId = req.query.pageId;
      if (!pageId) { res.status(400).json({ error: 'pageId가 필요해요.' }); return; }
      const content = await fetchDiaryContent(pageId);
      res.status(200).json({ content });
      return;
    }

    if (req.method === 'GET') {
      if (!appConfig.fromPage) {
        res.status(400).json({ error: `이 앱(${appKey})은 아직 노션에서 불러오기(pull)를 지원하지 않아요.` });
        return;
      }
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

      // 갤러리는 사진을 페이지 본문에 드래그해서 넣는 경우가 많아서(Photo 속성이 아니라),
      // Photo 속성이 비어있으면 본문의 첫 이미지 블록에서 대신 가져와요.
      if (appKey === 'gallery') {
        await Promise.all(items.map(async (item) => {
          if (!item.photo && item.notionPageId) {
            try { item.photo = await fetchFirstImageBlockUrl(item.notionPageId); }
            catch (e) { /* 본문에도 이미지가 없으면 그냥 넘어감 */ }
          }
        }));
      }

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
