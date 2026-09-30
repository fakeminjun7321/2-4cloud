import React, { useEffect, useState } from 'react';
import { api, jsonRequest } from '../api.js';

function supportsPush() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function decodePublicKey(base64) {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = atob(padded);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

export default function NotificationSettings() {
  const [publicKey, setPublicKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [mealEnabled, setMealEnabled] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supportsPush()) {
      setLoading(false);
      return undefined;
    }
    let live = true;
    async function load() {
      try {
        const [settings, registration] = await Promise.all([
          api('/push/public-key'),
          navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }),
        ]);
        const subscription = await registration.pushManager.getSubscription();
        if (!live) return;
        setPublicKey(settings.publicKey || '');
        setEnabled(Boolean(settings.enabled && settings.publicKey));
        setMealEnabled(Boolean(settings.mealEnabled));
        setSubscribed(Boolean(subscription));
      } catch (failure) {
        if (live) setError(failure.message || '알림 설정을 불러오지 못했어요.');
      } finally {
        if (live) setLoading(false);
      }
    }
    load();
    return () => { live = false; };
  }, []);

  async function subscribe() {
    setError('');
    if (!enabled || !publicKey) return;
    setBusy(true);
    let subscription;
    try {
      // The permission prompt must come directly from this button action.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError(permission === 'denied' ? '브라우저 설정에서 이 사이트의 알림을 허용해 주세요.' : '알림을 허용하면 신청할 수 있어요.');
        return;
      }
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodePublicKey(publicKey),
      });
      await api('/push/subscriptions', jsonRequest('POST', { subscription: subscription.toJSON() }));
      setSubscribed(true);
    } catch (failure) {
      if (subscription) await subscription.unsubscribe().catch(() => {});
      setError(failure.message || '알림 신청에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setError('');
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api('/push/subscriptions', jsonRequest('DELETE', {
          endpoint: subscription.endpoint,
          auth: subscription.toJSON().keys.auth,
        }));
        await subscription.unsubscribe();
      }
      setSubscribed(false);
    } catch (failure) {
      setError(failure.message || '알림 해제에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }

  const unsupported = !supportsPush();
  const denied = !unsupported && Notification.permission === 'denied';
  return (
    <section className="notification-settings" aria-labelledby="notification-title">
      <div>
        <p className="notification-kicker">PWA 알림</p>
        <h2 id="notification-title">놓치기 쉬운 일정을 알려드려요</h2>
        <p>시험·수행평가·제출 일정은 7일 전, 1일 전, 당일에 알려드려요. 매일 오전 7시에 묶어서 보내요.</p>
        <p className="notification-note">{mealEnabled ? '오늘 급식도 오전 7시 알림에 함께 담아요.' : '급식 알림은 NEIS 운영 API 키를 연결한 뒤 시작돼요.'}</p>
        <p className="notification-note">신청한 기기에만 전송하며, 사이트에서 무음으로 표시해요. 기기 설정에 따라 표시 방식은 달라질 수 있어요.</p>
        {unsupported && <p className="notification-help">이 브라우저에서는 푸시 알림을 사용할 수 없어요. iPhone에서는 홈 화면에 앱을 추가한 뒤 다시 열어 주세요.</p>}
        {!unsupported && !loading && !enabled && !error && <p className="notification-help">현재 알림 서버가 준비 중이에요.</p>}
        {denied && <p className="notification-help">알림이 차단되어 있어요. 브라우저 또는 기기 설정에서 이 사이트의 알림을 허용해 주세요.</p>}
        {error && <p className="form-error notification-error" role="alert">{error}</p>}
      </div>
      <div className="notification-action">
        {subscribed ? <button className="secondary-button" onClick={unsubscribe} disabled={busy}>{busy ? '처리 중…' : '알림 끄기'}</button> :
          <button className="secondary-button" onClick={subscribe} disabled={unsupported || loading || busy || !enabled || denied}>{busy ? '처리 중…' : loading ? '확인 중…' : '알림 받기'}</button>}
        {subscribed && <span className="notification-active">이 기기에서 알림 받는 중</span>}
      </div>
    </section>
  );
}
