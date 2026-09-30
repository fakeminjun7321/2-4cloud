import React, { useEffect, useState } from 'react';

const MEAL_ORDER = [
  { code: '1', name: '아침' },
  { code: '2', name: '점심' },
  { code: '3', name: '저녁' },
];

function formatKoreanDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return '오늘';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date(`${day}T12:00:00+09:00`));
}

export default function Meals() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [networkError, setNetworkError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setNetworkError('');
      try {
        const response = await fetch('/api/meals/today', {
          credentials: 'same-origin', signal: controller.signal,
        });
        const body = await response.json();
        if (!body || !['ok', 'no_meal', 'unconfigured', 'error'].includes(body.status)) {
          throw new Error('급식 응답을 확인할 수 없어요.');
        }
        setResult(body);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setResult(null);
        setNetworkError(failure.message || '급식 정보를 불러오지 못했어요.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [reloadKey]);

  const meals = MEAL_ORDER.map((slot) => result?.meals?.find((meal) => meal.code === slot.code) || {
    ...slot, available: false, dishes: [], calories: null,
  });
  const unavailable = result?.status === 'unconfigured' || result?.status === 'error' || Boolean(networkError);

  return (
    <section className="meals-page" aria-labelledby="meals-title">
      <div className="page-heading-row meals-heading">
        <div>
          <p className="meals-eyebrow">오늘의 학교급식</p>
          <h1 id="meals-title">급식</h1>
          <p className="meals-date">{result?.date ? formatKoreanDate(result.date) : '한국시간 기준 오늘'}</p>
        </div>
        <button className="secondary-button meals-refresh" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>{loading ? '확인 중…' : '새로고침'}</button>
      </div>

      {loading ? <p className="meals-status" role="status">오늘 급식을 불러오는 중…</p> : null}
      {!loading && (unavailable || result?.status === 'no_meal') ?
        <div className={`meals-status ${unavailable ? 'meals-status-error' : ''}`} role={unavailable ? 'alert' : 'status'}>
          <strong>{result?.status === 'unconfigured' ? '급식 연동 준비 중' : result?.status === 'no_meal' ? '오늘 등록된 급식이 없어요' : '급식 정보를 불러오지 못했어요'}</strong>
          {result?.status === 'unconfigured' ? <span>나이스 급식 연동이 준비되면 이곳에서 확인할 수 있어요.</span> :
            result?.status === 'no_meal' ? <span>방학이나 휴일에는 급식이 등록되지 않을 수 있어요.</span> :
              <span>잠시 후 새로고침해 주세요.</span>}
        </div> : null}

      {!loading && result?.status === 'ok' ? <div className="meal-grid">
        {meals.map((meal) => <article className="meal-card" key={meal.code}>
          <div className="meal-card-head"><span className="meal-number">{meal.code.padStart(2, '0')}</span><h2>{meal.name}</h2></div>
          {meal.available && meal.dishes.length ? <ul className="meal-dishes">{meal.dishes.map((dish, index) => <li key={`${meal.code}-${index}`}>{dish}</li>)}</ul> :
            <p className="meal-empty">{meal.name} 급식 정보가 없어요.</p>}
          {meal.available && meal.calories ? <p className="meal-calories">{meal.calories}</p> : null}
        </article>)}
      </div> : null}

      {!loading && ['ok', 'no_meal'].includes(result?.status) && result?.source === 'NEIS' &&
        <p className="meals-source">자료 출처: 나이스(NEIS) 학교급식정보</p>}
    </section>
  );
}
