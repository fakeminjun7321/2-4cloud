import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, jsonRequest } from '../api.js';
import { inferEventFromTitle } from '../classifyLocal.js';
import { Icon } from './Icons.jsx';
import Modal from './Modal.jsx';

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const COLORS = { 시험: 'exam', 수행평가: 'assignment', 제출: 'due', 기타: 'other' };

function isoDay(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function EventForm({ event, date, subjects, teachers, onClose, refresh, notify }) {
  const titleRef = useRef(null);
  const manual = useRef({ eventType: false, subject: false, teacher: false });
  const [title, setTitle] = useState(event?.title ?? '');
  const [eventDate, setEventDate] = useState(event?.event_date ?? date ?? isoDay(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  const [eventType, setEventType] = useState(event?.event_type ?? '기타');
  const [subjectId, setSubjectId] = useState(event?.subject_id ?? '');
  const [teacherId, setTeacherId] = useState(event?.teacher_id ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [notifyEnabled, setNotifyEnabled] = useState(event?.notify_enabled !== false && event?.notify_enabled !== 0);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(event?.subject_id || event?.teacher_id || event?.description));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [titleHint, setTitleHint] = useState(null);
  const eligibleTeachers = teachers.filter((teacher) => teacher.subject_id === Number(subjectId));

  function changeTitle(value) {
    setTitle(value);
    if (event) return;
    const hint = inferEventFromTitle(value, subjects, teachers);
    setTitleHint(hint);
    if (!manual.current.eventType) setEventType(hint.event_type || '기타');
    if (!manual.current.subject) setSubjectId(hint.subject_id === null ? '' : String(hint.subject_id));
    if (!manual.current.teacher) {
      const subject = manual.current.subject ? Number(subjectId) : hint.subject_id;
      setTeacherId(hint.teacher_id && hint.subject_id === subject ? String(hint.teacher_id) : '');
    }
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  async function submit(submitEvent) {
    submitEvent.preventDefault();
    if (!title.trim()) {
      setError('일정 제목을 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        title: title.trim(), event_date: eventDate, event_type: eventType,
        subject_id: subjectId ? Number(subjectId) : null,
        teacher_id: teacherId ? Number(teacherId) : null,
        description,
        notify_enabled: eventType === '기타' ? false : notifyEnabled,
      };
      await api(event ? `/events/${event.id}` : '/events', jsonRequest(event ? 'PUT' : 'POST', body));
      await refresh();
      notify(event ? '일정을 수정했어요.' : '일정을 등록했어요.');
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={event ? '일정 수정' : '일정 등록'} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>일정 제목<input ref={titleRef} value={title} onChange={(e) => changeTitle(e.target.value)} maxLength={120} placeholder="예: 국어 수행평가, 영어 학습지 제출" required /></label>
        {!event && titleHint && (titleHint.event_type || titleHint.subject_id) && <p className="event-title-hint">제목에서 {titleHint.subject_id ? `${subjects.find((subject) => subject.id === titleHint.subject_id)?.name || '과목'} · ` : ''}{titleHint.event_type || '일정'} 단서를 찾았어요. 입력값을 확인해 주세요.</p>}
        <div className="form-row"><label>날짜<input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} required /></label><label>유형<select value={eventType} onChange={(e) => { manual.current.eventType = true; setEventType(e.target.value); }}>{['기타', '시험', '수행평가', '제출'].map((type) => <option key={type}>{type}</option>)}</select></label></div>
        <details className="event-advanced" open={advancedOpen} onToggle={(toggleEvent) => setAdvancedOpen(toggleEvent.currentTarget.open)}>
          <summary>과목·선생님·설명 (선택)</summary>
          <div className="event-advanced-fields">
            <div className="form-row"><label>과목<select value={subjectId} onChange={(e) => { manual.current.subject = true; manual.current.teacher = true; setSubjectId(e.target.value); setTeacherId(''); }}><option value="">과목 선택 안 함</option>{subjects.map((subject) => <option value={subject.id} key={subject.id}>{subject.name}</option>)}</select></label><label>선생님<select value={teacherId} onChange={(e) => { manual.current.teacher = true; setTeacherId(e.target.value); }} disabled={!subjectId}><option value="">선택 안 함</option>{eligibleTeachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}T</option>)}</select></label></div>
            <label>설명<textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} placeholder="시험범위나 준비물을 적어 주세요." /></label>
          </div>
        </details>
        {eventType === '기타' ?
          <p className="field-help">기타 일정은 알림을 보내지 않아요. 시험·수행평가·제출 일정에서 알림을 설정할 수 있어요.</p> :
          <label className="checkbox-label"><input type="checkbox" checked={notifyEnabled} onChange={(e) => setNotifyEnabled(e.target.checked)} /><span>이 일정의 알림 보내기 <small>알림을 신청한 학생에게 7일 전, 1일 전, 당일</small></span></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button type="button" className="secondary-button" onClick={onClose}>취소</button><button className="primary-button" disabled={busy}>{busy ? '저장 중…' : '저장하기'}</button></div>
      </form>
    </Modal>
  );
}

function EventDetail({ event, admin, onClose, onEdit, refresh, notify }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await api(`/events/${event.id}`, { method: 'DELETE' });
      await refresh();
      notify('일정을 삭제했어요.');
      onClose();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={event.title} onClose={onClose}>
      <div className="detail-meta"><span>{event.event_date}</span><span>{event.event_type}</span>{event.subject_name && <span>{event.subject_name}</span>}{event.teacher_name && <span>{event.teacher_name}T</span>}</div>
      {event.description && <p className="detail-note">{event.description}</p>}
      {admin && <div className="event-actions"><button className="secondary-button" onClick={onEdit}>수정</button>{!confirmDelete ? <button className="danger-text-button" onClick={() => setConfirmDelete(true)}>삭제</button> : <div className="delete-confirm"><span>이 일정을 삭제할까요?</span><button className="secondary-button" onClick={() => setConfirmDelete(false)}>취소</button><button className="danger-button" onClick={remove} disabled={busy}>삭제</button></div>}</div>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}

export default function Calendar({ data, refresh, notify }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [form, setForm] = useState(null);
  const [selected, setSelected] = useState(null);
  const firstDay = new Date(year, month, 1).getDay();
  const dayCount = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((firstDay + dayCount) / 7) * 7;
  const today = isoDay(now.getFullYear(), now.getMonth(), now.getDate());
  const defaultAddDate = year === now.getFullYear() && month === now.getMonth() ? today : isoDay(year, month, 1);
  const eventsByDay = useMemo(() => {
    const grouped = new Map();
    data.events.forEach((event) => grouped.set(event.event_date, [...(grouped.get(event.event_date) || []), event]));
    return grouped;
  }, [data.events]);
  const monthEvents = data.events.filter((event) => event.event_date.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`));

  function shiftMonth(delta) {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  }
  function openEdit() {
    setForm({ event: selected });
    setSelected(null);
  }
  return (
    <section className="calendar-page">
      <div className="page-heading-row calendar-heading">
        <h1>캘린더</h1>
        <div className="calendar-controls">
          {data.admin && <button className="primary-button event-add-button" onClick={() => setForm({ date: defaultAddDate })} aria-label={`${defaultAddDate} 일정 등록`}><Icon name="plus" size={18} />일정 등록</button>}
          <button className="square-button" aria-label="이전 달" onClick={() => shiftMonth(-1)}><Icon name="chevronLeft" size={18} /></button>
          <strong className="month-label">{year}년 {month + 1}월</strong>
          <button className="square-button" aria-label="다음 달" onClick={() => shiftMonth(1)}><Icon name="chevronRight" size={18} /></button>
          <button className="secondary-button today-button" onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()); }}>오늘</button>
        </div>
      </div>
      {data.admin && <p className="calendar-add-hint">날짜를 눌러 그날의 일정을 바로 등록할 수 있어요.</p>}
      <div className="calendar-scroll"><div className="calendar-grid" role="grid" aria-label={`${year}년 ${month + 1}월 일정`}>
        {DAYS.map((day) => <div className="weekday" key={day} role="columnheader">{day}</div>)}
        {Array.from({ length: cellCount }, (_, index) => {
          const day = index - firstDay + 1;
          const inMonth = day > 0 && day <= dayCount;
          const date = inMonth ? isoDay(year, month, day) : '';
          const dayEvents = eventsByDay.get(date) || [];
          return <div key={index} className={`calendar-cell ${inMonth ? '' : 'outside'} ${date === today ? 'is-today' : ''}`} role="gridcell">
            {inMonth && <>{data.admin ? <button className="date-number" onClick={() => setForm({ date })} aria-label={`${month + 1}월 ${day}일 일정 등록`}>{day}</button> : <span className="date-number">{day}</span>}<div className="day-events">{dayEvents.slice(0, 2).map((event) => <button key={event.id} className={`event-chip ${COLORS[event.event_type]}`} onClick={() => setSelected(event)} title={event.title}><span>{event.title}</span></button>)}{dayEvents.length > 2 && <span className="more-events">+{dayEvents.length - 2}개</span>}</div></>}
          </div>;
        })}
      </div></div>
      {!monthEvents.length && <p className="empty-events">등록된 일정이 없어요</p>}
      {form && <EventForm event={form.event} date={form.date} subjects={data.subjects} teachers={data.teachers} refresh={refresh} notify={notify} onClose={() => setForm(null)} />}
      {selected && <EventDetail event={selected} admin={data.admin} refresh={refresh} notify={notify} onEdit={openEdit} onClose={() => setSelected(null)} />}
    </section>
  );
}
