// 책 검색 프록시.
//
// 검색은 카카오로 하고(제일 안정적), 표지는 정보나루(국립중앙도서관, data4library.kr)에서
// ISBN으로 따로 보강해요.
//
// 정보나루의 표지 주소는 사실 알라딘 자체 이미지 서버(image.aladin.co.kr)를 그대로 가리켜요.
// 다만 알라딘이 종료하는 건 유료로 운영하던 "OpenAPI(검색/조회) 서비스"고, 이 이미지 서버는
// 알라딘 쇼핑몰이 직접 쓰는 인프라라 별개로 계속 운영될 가능성이 높아요. 화질도 기존에
// 알라딘 API로 받던 것과 같은 소스라, 정보나루 키만 살아있으면 화질 걱정은 안 해도 돼요.
//
// 환경변수:
//   DATA4LIBRARY_KEY    — 정보나루 인증키 (없으면 카카오 표지 그대로 사용, 화질만 예전 수준)
//   KAKAO_REST_API_KEY  — 카카오 키 (검색 자체는 항상 이걸로)
//
// 사용법: GET /api/books?q=검색어

async function fetchData4LibraryCover(isbn13, key) {
  if (!isbn13 || !key) return null;
  try {
    const url = `https://data4library.kr/api/srchDtlList?authKey=${encodeURIComponent(key)}&isbn13=${encodeURIComponent(isbn13)}&loaninfoYN=N&format=json`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    // 정보나루 응답 구조가 문서마다 조금씩 다르게 적혀있어서, 있을 수 있는 모양을 순서대로 확인해요.
    const book = data?.response?.detail?.[0]?.book || data?.response?.book;
    const img = book?.bookImageURL;
    if (!img) return null;
    return String(img).replace('http://', 'https://');
  } catch (e) {
    return null; // 표지 보강 실패해도 검색 자체는 계속 되게
  }
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
    // 카카오 썸네일 주소 안에 리사이즈 전 원본 주소(fname)가 들어있어서, 정보나루에서 표지를
    // 못 찾았을 때 최소한 이거라도 원본으로 쓰게 남겨둬요.
    let fallbackCover = thumbnail;
    const m = thumbnail.match(/[?&]fname=([^&]+)/);
    if (m) { try { fallbackCover = decodeURIComponent(m[1]).replace('http://', 'https://'); } catch (e) {} }
    return {
      title: d.title || '',
      authors: d.authors || [],
      publisher: d.publisher || '',
      thumbnail,
      cover: fallbackCover,
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

  const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
  if (!KAKAO_KEY) {
    res.status(500).json({ error: 'KAKAO_REST_API_KEY 환경변수가 필요해요.' });
    return;
  }

  try {
    const items = await searchKakao(q, KAKAO_KEY);

    const D4L_KEY = process.env.DATA4LIBRARY_KEY;
    if (D4L_KEY) {
      // ISBN이 있는 항목만, 병렬로 정보나루 표지를 찔러봐서 있으면 그걸로 교체해요.
      await Promise.all(items.map(async (item) => {
        if (!item.isbn) return;
        const betterCover = await fetchData4LibraryCover(item.isbn, D4L_KEY);
        if (betterCover) item.cover = betterCover;
      }));
    }

    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류가 발생했어요.' });
  }
};
