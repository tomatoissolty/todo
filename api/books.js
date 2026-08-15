// 책 검색 프록시.
//
// 표지 화질 때문에 알라딘을 1순위로 씁니다:
//   - 카카오: 120x174 썸네일 하나만 줘요. 다른 크기 선택지가 아예 없어서 화질이 깨져 보였어요.
//   - 알라딘: Cover 파라미터로 크기를 고를 수 있고(Big = 너비 200px), 알라딘 이미지 서버는
//            주소의 크기 부분만 바꾸면 500px짜리도 갖고 있어요(cover500). 실제로 있는지는
//            저장할 때 서버가 직접 확인하고 씁니다(api/notion.js).
//
// 환경변수:
//   ALADIN_TTB_KEY      — 알라딘 TTBKey (없으면 자동으로 카카오로 넘어가요)
//   KAKAO_REST_API_KEY  — 기존 카카오 키 (알라딘 실패 시 예비용)
//
// 사용법: GET /api/books?q=검색어

async function searchAladin(q, key) {
  const url = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx`
    + `?ttbkey=${encodeURIComponent(key)}`
    + `&Query=${encodeURIComponent(q)}`
    + `&QueryType=Keyword&SearchTarget=Book&MaxResults=10&start=1`
    + `&Cover=Big&Output=JS&Version=20131101`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`알라딘 검색 실패 (status ${r.status})`);
  const text = await r.text();
  let data;
  try {
    // 알라딘 JS 출력은 끝에 세미콜론이 붙어 오는 경우가 있어요
    data = JSON.parse(text.trim().replace(/;$/, ''));
  } catch (e) {
    throw new Error('알라딘 응답을 읽지 못했어요');
  }
  if (data.errorCode) throw new Error(data.errorMessage || '알라딘 오류');

  return (data.item || []).map(d => ({
    title: d.title || '',
    // 알라딘은 저자를 한 문자열로 주기 때문에, 앱이 쓰는 배열 형태로 맞춰줘요
    authors: d.author ? [d.author] : [],
    publisher: d.publisher || '',
    thumbnail: d.cover || '',
    cover: d.cover || '',
    isbn: d.isbn13 || d.isbn || ''
  }));
}

async function searchKakao(q, key) {
  const r = await fetch(`https://dapi.kakao.com/v3/search/book?query=${encodeURIComponent(q)}&size=10`, {
    headers: { 'Authorization': `KakaoAK ${key}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || `카카오 도서 검색 실패 (status ${r.status})`);

  return (data.documents || []).map(d => {
    const isbns = (d.isbn || '').split(' ').filter(Boolean);
    const thumbnail = (d.thumbnail || '').replace('http://', 'https://');
    // 카카오 썸네일 주소 안에 리사이즈 전 원본 주소(fname)가 들어있어서, 있으면 그걸 표지로 써요
    let cover = thumbnail;
    const m = thumbnail.match(/[?&]fname=([^&]+)/);
    if (m) { try { cover = decodeURIComponent(m[1]).replace('http://', 'https://'); } catch (e) {} }
    return {
      title: d.title || '',
      authors: d.authors || [],
      publisher: d.publisher || '',
      thumbnail,
      cover,
      isbn: isbns[isbns.length - 1] || ''
    };
  });
}

module.exports = async (req, res) => {
  const q = req.query && req.query.q;
  if (!q) {
    res.status(400).json({ error: '검색어(q)가 필요해요.' });
    return;
  }

  const ALADIN_KEY = process.env.ALADIN_TTB_KEY;
  const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;

  if (ALADIN_KEY) {
    try {
      const items = await searchAladin(q, ALADIN_KEY);
      if (items.length) { res.status(200).json({ items, source: 'aladin' }); return; }
      // 알라딘에 결과가 없으면 카카오로 한 번 더 (커버리지 보완)
    } catch (err) {
      console.warn('알라딘 검색 실패, 카카오로 대체:', err.message);
    }
  }

  if (!KAKAO_KEY) {
    res.status(500).json({ error: 'ALADIN_TTB_KEY 또는 KAKAO_REST_API_KEY 환경변수가 필요해요.' });
    return;
  }
  try {
    const items = await searchKakao(q, KAKAO_KEY);
    res.status(200).json({ items, source: 'kakao' });
  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류가 발생했어요.' });
  }
};
