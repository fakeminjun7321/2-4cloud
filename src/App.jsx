import React, { useCallback, useEffect, useState } from 'react';
import { api, jsonRequest } from './api.js';
import Modal from './components/Modal.jsx';
import Materials from './components/Materials.jsx';
import Calendar from './components/Calendar.jsx';
import NotificationSettings from './components/NotificationSettings.jsx';

const GITHUB_REPOSITORY_URL = 'https://github.com/fakeminjun7321/2-4-cloud';

function routeFromPath() {
  if (window.location.pathname === '/support') return 'support';
  if (window.location.pathname === '/calendar') return 'calendar';
  return 'materials';
}

function SupportPage({ onBack }) {
  return (
    <section className="support-page" aria-labelledby="support-title">
      <button className="support-back" onClick={onBack}>← 자료실로 돌아가기</button>
      <div className="support-panel">
        <p className="support-eyebrow">2-4 cloud를 만든 사람</p>
        <h1 id="support-title">개발자에게 커피 사주기</h1>
        <p className="support-intro">자료실이 도움이 됐다면 작은 응원을 보내줘도 좋아요.</p>
        <div className="donation-detail">
          <span>후원 :</span>
          <strong>우리은행 구민준 : 1002-765-938273</strong>
        </div>
        <div className="other-projects">
          <h2>이 개발자가 만든 다른 프로젝트들</h2>
          <a href="https://quilolab.com" target="_blank" rel="noopener noreferrer">Quilo <span aria-hidden="true">↗</span></a>
          <a href="https://lod-student.fakeminjun7321-f03.workers.dev/app/activity/time" target="_blank" rel="noopener noreferrer">fakelod <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </section>
  );
}

function LoginModal({ onClose, onSuccess }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/login', jsonRequest('POST', { password }));
      onSuccess();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="관리자 로그인" onClose={onClose}>
      <p className="modal-description">자료와 일정을 등록하거나 수정할 때 사용해요.</p>
      <form onSubmit={submit} className="form-stack">
        <label>비밀번호<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button full-button" disabled={busy}>{busy ? '확인 중…' : '들어가기'}</button>
      </form>
    </Modal>
  );
}

export default function App() {
  const [tab, setTab] = useState(routeFromPath);
  const [data, setData] = useState({ subjects: [], materials: [], events: [], admin: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    const fresh = await api('/bootstrap');
    setData(fresh);
    setLoading(false);
    return fresh;
  }, []);

  useEffect(() => {
    refresh().catch((failure) => {
      setError(failure.message);
      setLoading(false);
    });
  }, [refresh]);

  useEffect(() => {
    const handlePopState = () => setTab(routeFromPath());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function navigate(path) {
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setTab(routeFromPath());
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  useEffect(() => {
    if (!message) return undefined;
    const timeout = window.setTimeout(() => setMessage(''), 3500);
    return () => window.clearTimeout(timeout);
  }, [message]);

  async function logout() {
    try {
      await api('/logout', { method: 'POST' });
      await refresh();
      setMessage('관리자에서 나왔어요.');
    } catch (failure) {
      setMessage(failure.message);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="site-title" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>2-4 cloud</a>
          <nav className="top-nav" aria-label="주 메뉴">
            <button className={tab === 'materials' ? 'active' : ''} onClick={() => navigate('/')} aria-current={tab === 'materials' ? 'page' : undefined}>자료실</button>
            <button className={tab === 'calendar' ? 'active' : ''} onClick={() => navigate('/calendar')} aria-current={tab === 'calendar' ? 'page' : undefined}>캘린더</button>
          </nav>
          <button className="admin-button" onClick={() => data.admin ? logout() : setLoginOpen(true)}>{data.admin ? '관리 종료' : '관리'}</button>
        </div>
      </header>
      <main className="main-content">
        {tab === 'support' ? <SupportPage onBack={() => navigate('/')} /> : loading ? <p className="state-message">불러오는 중…</p> : error ? <div className="state-message" role="alert">{error}<button className="text-button" onClick={() => { setError(''); setLoading(true); refresh().catch((failure) => { setError(failure.message); setLoading(false); }); }}>다시 시도</button></div> : tab === 'materials' ?
          <Materials data={data} refresh={refresh} notify={setMessage} /> :
          <><Calendar data={data} refresh={refresh} notify={setMessage} /><NotificationSettings /></>}
      </main>
      <footer className="site-footer">
        <div className="footer-inner">
          <a className="coffee-link" href="/support" onClick={(event) => { event.preventDefault(); navigate('/support'); }}>☕ 개발자에게 커피 사주기</a>
          <div className="footer-meta">
            <span>© 2026 구민준 · 코드 MIT 라이선스</span>
            <a href={GITHUB_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href={`${GITHUB_REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">저작권 및 라이선스</a>
          </div>
        </div>
      </footer>
      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} onSuccess={async () => { await refresh(); setLoginOpen(false); setMessage('관리자 권한으로 들어왔어요.'); }} />}
      {message && <div className="toast" role="status">{message}</div>}
    </div>
  );
}
