// 여러 앱(Daily 할 일, REEL 영화 기록 등)이 공유하는 노션 동기화 프록시
// 노션 시크릿 키는 여기(서버) 환경변수에만 있고, 브라우저에는 절대 노출되지 않아요.
//
// 필요한 환경변수 (Vercel 프로젝트 Settings → Environment Variables):
//   NOTION_SECRET            — 노션 인테그레이션의 Internal Integration Secret (공용)
//   NOTION_DATABASE_ID       — "✅ Daily 할 일" 데이터베이스 ID (todo 앱, 기존 이름 유지)
//   NOTION_DATABASE_ID_MOVIE — "🎬 REEL 영화 기록" 데이터베이스 ID
//   NOTION_DATABASE_ID_TRACE — "✏️ TRACE 영어 학습" 데이터베이스 ID (/trace 앱)
//   NOTION_DATABASE_ID_HABITLOG — 12 Week Year "Habit Log" 데이터베이스 ID (할 일 → 해빗 트래커 연동, 없으면 기본값 사용)
//   NOTION_DATABASE_ID_HABITS   — 12 Week Year "Weekly Actions" 데이터베이스 ID (장바구니, 없으면 기본값 사용)
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
    // Routine은 켜기만 하고 끄지는 않아요. 어떤 앱이 루틴 표시를 잃어버린 채 저장해도
    // 노션의 루틴 표시가 지워지지 않게 하려는 안전장치예요. (9/26 사고: 앱이 false로 덮어씀)
    ...(item.routine ? { 'Routine': { checkbox: true } } : {}),
    'Deferred': { checkbox: !!item.deferred },
    'Subtasks': { rich_text: item.subtasks ? [{ text: { content: item.subtasks } }] : [] },
    // 장바구니로 담은 항목만 습관 ID를 가져요. 다른 앱이 이 값을 모르고 저장해도 지워지지 않게, 있을 때만 씁니다.
    ...(item.habitId ? { 'Habit ID': { rich_text: [{ text: { content: String(item.habitId) } }] } } : {}),
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
    habitId: richText(p['Habit ID']) || null,
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

  let numberedCount = 0;
  return blocks.map(b => {
    if (b.type === 'image') {
      const img = b.image || {};
      const url = (img.file && img.file.url) || (img.external && img.external.url) || null;
      return { type: 'photo', url };
    }
    if (b.type === 'divider') { numberedCount = 0; return { type: 'text', text: '' }; }

    // 노션은 문단(paragraph) 말고도 제목/목록/인용/할일 등 블록 종류가 다양한데, 실제 글자는
    // 전부 [블록타입].rich_text 안에 똑같은 모양으로 들어있어요. 예전엔 paragraph만 읽어서
    // 다른 블록 타입(특히 목록·제목)의 글이 통째로 빈 줄로 사라졌던 게 진짜 원인이었어요.
    const richText = (b[b.type] && b[b.type].rich_text) || [];
    let text = richText.map(t => t.plain_text).join('');

    if (b.type === 'bulleted_list_item') { text = '• ' + text; numberedCount = 0; }
    else if (b.type === 'numbered_list_item') { numberedCount++; text = numberedCount + '. ' + text; }
    else if (b.type === 'to_do') { text = (b.to_do && b.to_do.checked ? '[x] ' : '[ ] ') + text; numberedCount = 0; }
    else if (b.type === 'quote') { text = '> ' + text; numberedCount = 0; }
    else { numberedCount = 0; }

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

  // 노션 API는 한 번 요청에 블록을 최대 100개까지만 허용해요. 긴 글/사진 많은 일기처럼
  // 100개가 넘으면 통째로 실패했던 게 진짜 원인 - 100개씩 나눠서 순서대로 보내도록 수정함.
  for (let i = 0; i < blocks.length; i += 100) {
    const chunk = blocks.slice(i, i + 100);
    if (!chunk.length) continue;
    const r2 = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: notionHeaders(),
      body: JSON.stringify({ children: chunk })
    });
    const data2 = await r2.json();
    if (!r2.ok) throw new Error(data2.message || '본문 저장 실패');
  }
}

// 사진을 노션 "자체" 비공개 저장소에 직접 업로드 (외부 공개 호스팅 절대 사용 안 함)
async function uploadFileToNotion(dataUrl, fileName) {
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
  form.append('file', new Blob([buffer], { type: mime }), fileName || 'photo.jpg');
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


// 알라딘 표지 주소는 크기가 경로에 들어있어요 (.../coversum/... , .../cover200/...).
// 그 부분만 cover500으로 바꾸면 더 큰 이미지가 있는 경우가 많아서, 실제로 있는지 서버가
// 직접 확인해보고 있으면 그걸 씁니다. 없으면 원래 주소 그대로 써요 (추측으로 넣지 않음).
async function bestQualityCoverUrl(url) {
  if (!url || !/image\.aladin\.co\.kr/.test(url)) return url;
  for (const size of ['cover500', 'cover200']) {
    const candidate = url.replace(/\/(coversum|cover\d+|cover)\//, `/${size}/`);
    if (candidate === url) continue;
    try {
      const r = await fetch(candidate, { method: 'HEAD' });
      if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) return candidate;
    } catch (e) { /* 다음 후보로 */ }
  }
  return url;
}

// 외부 이미지 주소를 서버에서 직접 내려받아 노션 저장소로 올려요.
// SHELF 표지가 노션 갤러리에서 흰색으로만 보이던 이유가 여기 있었어요 — 표지를 카카오 CDN 주소
// "링크"로만 넣어두면, 노션이 그 이미지를 가져오려 할 때 외부 CDN 쪽에서 막아버려 빈 칸이 돼요.
// (앱 안에서는 브라우저가 직접 불러오니까 잘 보이고요.) 노션이 파일을 직접 갖고 있게 하면 확실해요.
const remoteUploadCache = new Map(); // 같은 표지를 저장할 때마다 다시 올리지 않도록
async function uploadRemoteImageToNotion(url) {
  if (!url) return null;
  if (remoteUploadCache.has(url)) return remoteUploadCache.get(url);
  try {
    const bestUrl = await bestQualityCoverUrl(url);
    const r = await fetch(bestUrl);
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') || 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buffer = Buffer.from(await r.arrayBuffer());
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    const id = await uploadFileToNotion(dataUrl, 'cover.jpg');
    remoteUploadCache.set(url, id);
    return id;
  } catch (e) {
    return null; // 표지를 못 가져와도 책 저장 자체는 실패하지 않게
  }
}

// --- Book(SHELF 독서 기록 앱) 매핑 ---
function bookToProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'Author': { rich_text: item.author ? [{ text: { content: item.author } }] : [] },
    'Publisher': { rich_text: item.publisher ? [{ text: { content: item.publisher } }] : [] },
    // coverFileUploadId가 있으면 노션이 직접 보관하는 파일로 넣어요(갤러리에서 확실히 보임).
    // 못 올렸을 때만 예전처럼 외부 링크로 넣어서, 최소한 주소는 남아있게 해요.
    'Cover': item.coverFileUploadId
      ? { files: [{ name: 'cover.jpg', type: 'file_upload', file_upload: { id: item.coverFileUploadId } }] }
      : (item.cover ? { files: [{ name: 'cover.jpg', type: 'external', external: { url: item.cover } }] } : { files: [] }),
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


// --- Expense(가계부 앱) 매핑 ---
function expenseToProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'Date': item.date ? { date: { start: item.date } } : { date: null },
    'Amount': { number: typeof item.amount === 'number' ? item.amount : null },
    'Split Count': { number: typeof item.splitCount === 'number' ? item.splitCount : 1 },
    'My Share': { number: typeof item.myShare === 'number' ? item.myShare : null },
    'Method': item.method ? { select: { name: item.method } } : { select: null },
    'Category': { rich_text: item.category ? [{ text: { content: item.category } }] : [] },
    'Type': { select: { name: item.type === 'income' ? '수입' : '지출' } },
    'App ID': { rich_text: [{ text: { content: String(item.appId || '') } }] },
    'Last Updated': item.updatedAt ? { date: { start: item.updatedAt } } : { date: null }
  };
}
function expenseFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  return {
    notionPageId: page.id,
    appId: richText(p['App ID']),
    name: titleText(p['Name']),
    date: p['Date']?.date?.start || null,
    amount: typeof p['Amount']?.number === 'number' ? p['Amount'].number : 0,
    splitCount: typeof p['Split Count']?.number === 'number' ? p['Split Count'].number : 1,
    myShare: typeof p['My Share']?.number === 'number' ? p['My Share'].number : 0,
    method: p['Method']?.select?.name || null,
    category: richText(p['Category']),
    type: p['Type']?.select?.name === '수입' ? 'income' : 'expense',
    lastUpdated: p['Last Updated']?.date?.start || null
  };
}


function writingToProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'Category': { select: item.category ? { name: item.category } : null },
    'Date': item.date ? { date: { start: item.date } } : { date: null },
    'App ID': { rich_text: [{ text: { content: String(item.appId || '') } }] },
    'Last Updated': item.updatedAt ? { date: { start: item.updatedAt } } : { date: null }
  };
}
function writingFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  return {
    notionPageId: page.id,
    appId: richText(p['App ID']),
    name: titleText(p['Name']),
    category: p['Category']?.select?.name || '',
    date: p['Date']?.date?.start || null,
    lastUpdated: p['Last Updated']?.date?.start || null
  };
}

// --- Storage(작은 파일 보관함) 매핑 ---
function storageToProperties(item) {
  return {
    'Name': { title: [{ text: { content: item.name || '(제목 없음)' } }] },
    'Memo': { rich_text: item.memo ? [{ text: { content: item.memo } }] : [] },
    'Date': { date: { start: item.date || new Date().toISOString().slice(0, 10) } },
    'File': item.fileUploadId
      ? { files: [{ name: item.fileName || 'file', type: 'file_upload', file_upload: { id: item.fileUploadId } }] }
      : undefined
  };
}
function storageFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  const file = (p['File']?.files || [])[0];
  const fileUrl = file ? ((file.file && file.file.url) || (file.external && file.external.url) || null) : null;
  return {
    notionPageId: page.id,
    name: titleText(p['Name']),
    memo: richText(p['Memo']),
    date: p['Date']?.date?.start || null,
    fileUrl,
    fileName: file ? file.name : null
  };
}


// --- Trace(TRACE 영어 학습 앱) 매핑 ---
// 카드는 첨삭 대화에서 노션에 직접 만들어지고, 앱은 학습 결과(복습단계/다음복습일/완료/오답횟수)만 되돌려 써요.
// '원문'은 앱이 건드리지 않으므로 저장 속성에서 일부러 뺐어요(노션 값이 그대로 보존됨).
// ⚠️ 이 설정은 다른 채팅방에서 만든 앱이라, 이 파일을 통째로 교체할 때 빠지지 않게 주의!
function traceToProperties(item) {
  return {
    '문장': { title: [{ text: { content: item.sentence || '(문장 없음)' } }] },
    '뜻': { rich_text: item.meaning ? [{ text: { content: item.meaning } }] : [] },
    '설명': { rich_text: item.note ? [{ text: { content: item.note } }] : [] },
    '분류': item.category ? { select: { name: item.category } } : { select: null },
    '빈칸': { rich_text: item.blank ? [{ text: { content: item.blank } }] : [] },
    '출처날짜': item.sourceDate ? { date: { start: item.sourceDate } } : { date: null },
    '복습단계': { number: typeof item.stage === 'number' ? item.stage : 0 },
    '다음복습일': item.nextDate ? { date: { start: item.nextDate } } : { date: null },
    '완료': { checkbox: !!item.done },
    '오답횟수': { number: typeof item.wrongCount === 'number' ? item.wrongCount : 0 }
  };
}
function traceFromPage(page) {
  const p = page.properties || {};
  const richText = (prop) => (prop?.rich_text || []).map(t => t.plain_text).join('');
  const titleText = (prop) => (prop?.title || []).map(t => t.plain_text).join('');
  return {
    notionPageId: page.id,
    sentence: titleText(p['문장']),
    meaning: richText(p['뜻']),
    original: richText(p['원문']),
    note: richText(p['설명']),
    category: p['분류']?.select?.name || '',
    blank: richText(p['빈칸']),
    sourceDate: p['출처날짜']?.date?.start || null,
    stage: typeof p['복습단계']?.number === 'number' ? p['복습단계'].number : 0,
    nextDate: p['다음복습일']?.date?.start || null,
    done: !!p['완료']?.checkbox,
    wrongCount: typeof p['오답횟수']?.number === 'number' ? p['오답횟수'].number : 0
  };
}

// --- 할 일 → 12 Week Year 해빗 트래커 연동 ---
// 아래 이름의 할 일을 체크하면 해빗 트래커(Habit Log)에 그날 기록을 자동으로 남기고,
// 체크를 풀면 자동으로 만든 기록만 지워요. (트래커에서 직접 누른 기록은 절대 안 건드림)
// 이름은 띄어쓰기/대소문자 무시하고 비교해요.
// 고정항목(루틴) 이름 ↔ 12 Week Year 습관 연결.
// 이름이 바뀌어도 끊기지 않도록, 한글 이름과 영어 이름을 모두 적어둬요.
// (루틴을 영어 이름으로 바꾼 뒤 연결이 끊겨서 해빗트래커에 기록이 안 들어갔어요)
const HABIT_LINKS = [
  { names: ['헤이링', 'Heyring'], habitId: 'fdca2001-420a-82dc-aaf5-81c5957bbb25', label: '🎧 Use Heyring for 15 minutes' },
  { names: ['말해보카'], habitId: '3e7a2001-420a-8100-84ee-f33925ce33c5', label: '🏆 Earn at least 1 trophy' },
  // 일기 쓰기 / 문법 수정은 둘 중 하나만 해도 같은 습관 1회로 쳐요
  { names: ['일기 쓰기 eng', '일기 문법 수정', 'Write English diary', 'Fix diary grammar'], habitId: '12da2001-420a-837b-ad86-010dce9ca18b', label: '✏️ Write a journal entry or fix its grammar' },
  { names: ['영어 강의 듣기', 'English lecture'], habitId: '3e7a2001-420a-812b-9a94-c8c5eeaeee34', label: '📺 Watch English lessons (2+ videos)' },
  // 운동 습관은 "플랭크 1분 이상"으로 정했으니 플랭크 체크를 운동 1회로 기록해요.
  // keepInCart: 다른 운동을 하고 싶은 날도 있어서, 자동 기록되더라도 장바구니에는 계속 보여줘요.
  { names: ['플랭크', 'Plank'], habitId: '38ca2001-420a-82e8-950b-01831bcc86f4', label: '🏃 Exercise', keepInCart: true }
];
const normName = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const normId = (s) => String(s || '').replace(/-/g, '').toLowerCase();
function findHabitLink(name) {
  const n = normName(name);
  return HABIT_LINKS.find(l => l.names.some(x => normName(x) === n)) || null;
}
// 장바구니로 담은 항목은 습관 ID를 직접 갖고 있고, 루틴(헤이링 등)은 이름으로 습관을 찾아요.
function resolveHabitLink(item) {
  if (item.habitId) {
    const known = HABIT_LINKS.find(l => normId(l.habitId) === normId(item.habitId));
    return { habitId: item.habitId, label: known ? known.label : (item.name || ''), names: known ? known.names : [] };
  }
  return findHabitLink(item.name);
}

// 12 Week Year 데이터베이스 ID - 비밀값이 아니라서 환경변수가 없으면 이 값을 써요.
const HABITS_DB_FALLBACK = 'e49a2001420a83cd9ddf01c77fe378bf';   // Weekly Actions (습관 목록)
const HABITLOG_DB_FALLBACK = 'eb5a2001420a83c5a17f81c0f483b6bd'; // Habit Log (체크 기록)
const habitLogDbId = () => process.env.NOTION_DATABASE_ID_HABITLOG || HABITLOG_DB_FALLBACK;
const habitsDbId = () => process.env.NOTION_DATABASE_ID_HABITS || HABITS_DB_FALLBACK;

async function notionQuery(dbId, filter) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST', headers: notionHeaders(), body: JSON.stringify({ filter, page_size: 100 })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || '노션 조회 실패');
  return data.results || [];
}
// 100개가 넘어도 끝까지 받아와요 (일주일치 체크 기록은 100개를 넘을 수 있음)
async function notionQueryAll(dbId, filter) {
  let all = [], cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers: notionHeaders(), body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || '노션 조회 실패');
    all = all.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function syncHabitLog(item, todoDbId) {
  const habitDbId = habitLogDbId();
  if (!habitDbId || !item || !item.date) return;
  const link = resolveHabitLink(item);
  if (!link) return;
  // 날짜는 할 일이 속한 날짜 그대로 써요. 앱이 하루를 새벽 기준으로 나누므로,
  // 새벽에 체크해도 할 일이 속한 "어제" 날짜로 기록돼요.
  const date = String(item.date).slice(0, 10);

  const logsThatDay = await notionQuery(habitDbId, {
    and: [
      { property: 'Habit', relation: { contains: link.habitId } },
      { property: 'Date', date: { equals: date } }
    ]
  });

  if (item.completed) {
    if (logsThatDay.length > 0) return; // 이미 그날 기록이 있으면 또 만들지 않음 (하루 1회)
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: notionHeaders(),
      body: JSON.stringify({
        parent: { database_id: habitDbId },
        properties: {
          'Name': { title: [{ text: { content: link.label } }] },
          'Date': { date: { start: date } },
          'Habit': { relation: [{ id: link.habitId }] },
          'From Todo': { checkbox: true }
        }
      })
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.message || '해빗 기록 생성 실패'); }
    return;
  }

  // 체크 해제(또는 미완료 상태로 저장): 자동으로 만든 기록만 지워요. 트래커에서 직접 누른 기록은 안 건드림.
  const autoLogs = logsThatDay.filter(p => p.properties?.['From Todo']?.checkbox);
  if (autoLogs.length === 0) return;
  // 같은 습관에 묶인 다른 할 일이 그날 완료돼 있으면 기록 유지
  // (일기 쓰기 ↔ 문법 수정, 루틴 "헤이링" ↔ 장바구니로 담은 헤이링 습관 등)
  const doneThatDay = await notionQuery(todoDbId, {
    and: [
      { property: 'Date', date: { equals: date } },
      { property: 'Completed', checkbox: { equals: true } }
    ]
  });
  const siblingDone = doneThatDay.some(p => {
    const appId = (p.properties?.['App ID']?.rich_text || []).map(x => x.plain_text).join('');
    if (item.appId && appId === String(item.appId)) return false;
    const hid = (p.properties?.['Habit ID']?.rich_text || []).map(x => x.plain_text).join('');
    if (hid && normId(hid) === normId(link.habitId)) return true;
    const t = (p.properties?.['Name']?.title || []).map(x => x.plain_text).join('');
    return link.names.some(x => normName(x) === normName(t));
  });
  if (siblingDone) return;
  await Promise.all(autoLogs.map(p => fetch(`https://api.notion.com/v1/pages/${p.id}`, {
    method: 'PATCH', headers: notionHeaders(), body: JSON.stringify({ archived: true })
  })));
}

// --- 오늘 할 일 장바구니: 이번 주 습관별 달성 현황 ---
// date(YYYY-MM-DD, 앱 기준 "오늘")가 속한 월~일 한 주 동안 각 습관을 며칠 했는지 세요.
// 쉬고 있는 습관(습관이나 목표가 On hold)은 Weekly Target이 0이라 빠져요.
const CATEGORY_ORDER = ['English', 'Health', 'Blog', 'Stock Images', 'Video'];
async function buildHabitCart(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) throw new Error('date 값이 필요해요 (YYYY-MM-DD)');
  const d = new Date(dateStr + 'T00:00:00Z');
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const iso = (x) => x.toISOString().slice(0, 10);

  const [habits, logs] = await Promise.all([
    notionQueryAll(habitsDbId()),
    notionQueryAll(habitLogDbId(), {
      and: [
        { property: 'Date', date: { on_or_after: iso(mon) } },
        { property: 'Date', date: { on_or_before: iso(sun) } }
      ]
    })
  ]);

  // 습관별로 "기록이 있는 날"을 모아요 (같은 날 여러 번 눌러도 1회)
  const daysByHabit = {};
  logs.forEach(p => {
    const day = String(p.properties?.['Date']?.date?.start || '').slice(0, 10);
    if (!day) return;
    (p.properties?.['Habit']?.relation || []).forEach(rel => {
      const k = normId(rel.id);
      (daysByHabit[k] = daysByHabit[k] || new Set()).add(day);
    });
  });

  const items = habits.map(h => {
    const p = h.properties || {};
    const name = (p['Habit']?.title || []).map(t => t.plain_text).join('').trim();
    let target = p['Weekly Target']?.formula?.number;
    if (typeof target !== 'number') {
      // 수식이 없을 때를 대비한 예비 계산: "3 Times / Week" → 3, On Hold면 0
      const paused = p['Status']?.status?.name === 'On Hold';
      target = paused ? 0 : (parseInt(p['Per Week']?.select?.name || '', 10) || 0);
    }
    const days = daysByHabit[normId(h.id)] || new Set();
    const link = HABIT_LINKS.find(l => normId(l.habitId) === normId(h.id));
    return {
      id: h.id, name, target, count: days.size,
      doneToday: days.has(dateStr),
      category: p['Category']?.select?.name || '',
      linkedNames: link ? link.names : [],
      keepInCart: !!(link && link.keepInCart)
    };
  }).filter(x => x.name && x.target > 0);

  items.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category);
    return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb);
  });
  return { weekStart: iso(mon), weekEnd: iso(sun), items };
}

function routineToProperties(item) {
  return {
    '이름': { title: [{ text: { content: item.text || '(이름 없음)' } }] },
    'App ID': { rich_text: item.appId ? [{ text: { content: item.appId } }] : [] },
    '순서': { number: typeof item.order === 'number' ? item.order : 0 }
  };
}
function routineFromPage(page) {
  const p = page.properties || {};
  return {
    notionPageId: page.id,
    appId: (p['App ID']?.rich_text || []).map(t => t.plain_text).join('') || '',
    text: (p['이름']?.title || []).map(t => t.plain_text).join(''),
    order: typeof p['순서']?.number === 'number' ? p['순서'].number : 0,
    createdTime: page.created_time
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
  },
  expense: {
    databaseId: () => process.env.NOTION_DATABASE_ID_EXPENSE,
    toProperties: expenseToProperties,
    fromPage: expenseFromPage,
    useCover: false
  },
  storage: {
    databaseId: () => process.env.NOTION_DATABASE_ID_STORAGE,
    toProperties: storageToProperties,
    fromPage: storageFromPage,
    useCover: false
  },
  writing: {
    databaseId: () => process.env.NOTION_DATABASE_ID_WRITING,
    toProperties: writingToProperties,
    fromPage: writingFromPage,
    useCover: false
  },
  routine: {
    databaseId: () => process.env.NOTION_DATABASE_ID_ROUTINE,
    toProperties: routineToProperties,
    fromPage: routineFromPage,
    useCover: false
  },
  trace: {
    databaseId: () => process.env.NOTION_DATABASE_ID_TRACE,
    toProperties: traceToProperties,
    fromPage: traceFromPage,
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
      const fileName = req.body && req.body.fileName;
      if (!dataUrl) { res.status(400).json({ error: 'dataUrl이 필요해요.' }); return; }
      const fileUploadId = await uploadFileToNotion(dataUrl, fileName);
      res.status(200).json({ fileUploadId });
      return;
    }

    // --- 일기 앱 전용 처리: 항목 하나 저장(속성 + 본문 블록) ---
    if ((appKey === 'diary' || appKey === 'writing') && req.method === 'POST' && !req.query.action) {
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
    if ((appKey === 'diary' || appKey === 'writing') && req.method === 'GET' && req.query.action === 'content') {
      const pageId = req.query.pageId;
      if (!pageId) { res.status(400).json({ error: 'pageId가 필요해요.' }); return; }
      const content = await fetchDiaryContent(pageId);
      res.status(200).json({ content });
      return;
    }

    // 오늘 할 일 장바구니: 이번 주 습관 달성 현황 (/api/notion?app=todo&action=cart&date=YYYY-MM-DD)
    if (appKey === 'todo' && req.method === 'GET' && req.query.action === 'cart') {
      try {
        res.status(200).json(await buildHabitCart(req.query.date));
      } catch (e) {
        res.status(500).json({ error: `습관 목록을 못 불러왔어요: ${e.message}` });
      }
      return;
    }

    if (req.method === 'GET') {
      if (!appConfig.fromPage) {
        res.status(400).json({ error: `이 앱(${appKey})은 아직 노션에서 불러오기(pull)를 지원하지 않아요.` });
        return;
      }
      let items = [];
      let cursor;
      // 투두는 화면에 어차피 오늘 기준 ±30일치만 보여주는데, 필터 없이 매번 몇 달치 전체 기록을
      // 다 받아오고 있었음 - 이게 노션 쿼리가 느려지고 들쭉날쭉했던 진짜 원인. 최근 범위로만 좁힘.
      let queryFilter = {};
      if (appKey === 'todo') {
        const today = new Date();
        const past = new Date(today); past.setDate(past.getDate() - 40);
        const future = new Date(today); future.setDate(future.getDate() + 40);
        const toStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        queryFilter = {
          filter: {
            and: [
              { property: 'Date', date: { on_or_after: toStr(past) } },
              { property: 'Date', date: { on_or_before: toStr(future) } }
            ]
          }
        };
      }
      do {
        const r = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
          method: 'POST',
          headers: notionHeaders(),
          body: JSON.stringify(cursor ? { ...queryFilter, start_cursor: cursor } : queryFilter)
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || '노션 조회 실패');
        items = items.concat((data.results || []).map(p => ({ ...appConfig.fromPage(p), notionEditedTime: p.last_edited_time })));
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
        // 서버 쪽 최종 안전장치: 노션에 루틴으로 저장된 항목을 "밀린 일"로 다른 날짜에 옮기려는 저장은 막아요.
        // 앱 쪽 버그가 또 생겨도 루틴이 오늘로 쏟아지는 일은 없게 됩니다.
        if (appKey === 'todo' && item.notionPageId && item.deferred && !item.routine) {
          try {
            const cur = await fetch(`https://api.notion.com/v1/pages/${item.notionPageId}`, { headers: notionHeaders() });
            const curData = await cur.json();
            // 장바구니로 담은 항목(Habit ID 있음)도 그날만 유효해서 다른 날로 미루지 않아요
            const isCartItem = (curData.properties?.['Habit ID']?.rich_text || []).length > 0;
            if (cur.ok && (curData.properties?.['Routine']?.checkbox || isCartItem)) {
              results.push({ appId: item.appId, notionPageId: item.notionPageId, skipped: 'routine-rollover-blocked' });
              continue;
            }
          } catch (e) { /* 확인 실패 시엔 평소대로 저장 */ }
        }
        // SHELF 표지는 외부 링크로 두면 노션 갤러리에서 안 보여서, 저장할 때 노션 저장소로 옮겨요.
        // 이미 노션이 갖고 있는 주소(재저장 시 되돌아온 것)면 다시 올릴 필요 없어요.
        if (appKey === 'book' && item.cover && !item.coverFileUploadId
            && !/(^https?:\/\/[^/]*notion)|amazonaws\.com/.test(item.cover)) {
          item.coverFileUploadId = await uploadRemoteImageToNotion(item.cover);
        }
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
        // 할 일 저장이 끝난 뒤 해빗 트래커 연동 - 실패해도 할 일 동기화는 절대 막지 않음
        if (appKey === 'todo') {
          try { await syncHabitLog(item, databaseId); }
          catch (e) { console.error('[habit-sync]', e.message); }
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
