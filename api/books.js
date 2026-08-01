// 카카오 책 검색 API 프록시 — 한국 도서 커버리지가 훨씬 좋아요.
// 필요한 환경변수: KAKAO_REST_API_KEY (카카오 디벨로퍼스에서 발급)
// 사용법: GET /api/books?q=검색어

module.exports = async (req, res) => {
  const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
  if (!KAKAO_KEY) {
    res.status(500).json({ error: 'KAKAO_REST_API_KEY 환경변수가 설정되지 않았어요.' });
    return;
  }
  const q = req.query && req.query.q;
  if (!q) {
    res.status(400).json({ error: '검색어(q)가 필요해요.' });
    return;
  }

  try {
    const r = await fetch(`https://dapi.kakao.com/v3/search/book?query=${encodeURIComponent(q)}&size=10`, {
      headers: { 'Authorization': `KakaoAK ${KAKAO_KEY}` }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || `카카오 도서 검색 실패 (status ${r.status})`);

    const items = (data.documents || []).map(d => {
      const isbns = (d.isbn || '').split(' ').filter(Boolean);
      return {
        title: d.title || '',
        authors: d.authors || [],
        publisher: d.publisher || '',
        thumbnail: (d.thumbnail || '').replace('http://', 'https://'),
        isbn: isbns[isbns.length - 1] || ''
      };
    });
    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || '알 수 없는 오류가 발생했어요.' });
  }
};
